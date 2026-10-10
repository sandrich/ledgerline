// Multicall3 aggregate3 at a historical block, chunked, allowFailure everywhere.
// Before Multicall3 existed on a chain we fall back to single eth_call / eth_getBalance.
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { RpcExecutionError, toHex, type RpcPool } from './rpc';
import { mapLimit, type HistoryChain } from './types';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const MULTICALL3_DEPLOY_BLOCK: Record<HistoryChain, number> = { ethereum: 14353601, arbitrum: 7654707 };
const CHUNK = 500;

const mc3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

export type HistCall = { kind: 'call'; target: Hex; data: Hex } | { kind: 'native'; address: Hex };
export interface HistResult {
  success: boolean;
  data: Hex;
}

export function nativeBalanceCall(address: string): HistCall {
  return { kind: 'native', address: address as Hex };
}

export async function multicallAt(
  rpc: RpcPool,
  chain: HistoryChain,
  block: number,
  calls: HistCall[],
  signal?: AbortSignal,
): Promise<HistResult[]> {
  if (calls.length === 0) return [];
  const blockTag = toHex(block);
  if (block < MULTICALL3_DEPLOY_BLOCK[chain]) {
    return mapLimit(calls, 2, async (c) => {
      try {
        if (c.kind === 'native') {
          const r = await rpc.request<Hex>('eth_getBalance', [c.address, blockTag], signal);
          return { success: true, data: `0x${BigInt(r).toString(16).padStart(64, '0')}` as Hex };
        }
        const r = await rpc.request<Hex>('eth_call', [{ to: c.target, data: c.data }, blockTag], signal);
        return { success: true, data: r };
      } catch (e) {
        if (e instanceof RpcExecutionError) return { success: false, data: '0x' as Hex };
        throw e;
      }
    });
  }
  const out: HistResult[] = [];
  for (let i = 0; i < calls.length; i += CHUNK) {
    const chunk = calls.slice(i, i + CHUNK);
    const data = encodeFunctionData({
      abi: mc3Abi,
      functionName: 'aggregate3',
      args: [
        chunk.map((c) =>
          c.kind === 'native'
            ? {
                target: MULTICALL3,
                allowFailure: true,
                callData: encodeFunctionData({ abi: mc3Abi, functionName: 'getEthBalance', args: [c.address] }),
              }
            : { target: c.target, allowFailure: true, callData: c.data },
        ),
      ],
    });
    const raw = await rpc.request<Hex>('eth_call', [{ to: MULTICALL3, data }, blockTag], signal);
    const decoded = decodeFunctionResult({ abi: mc3Abi, functionName: 'aggregate3', data: raw }) as readonly {
      success: boolean;
      returnData: Hex;
    }[];
    if (decoded.length !== chunk.length) throw new Error(`multicall returned ${decoded.length} results for ${chunk.length} calls`);
    for (const r of decoded) out.push({ success: r.success, data: r.returnData });
  }
  return out;
}

/** Decode a uint256 word; empty / short / failed results count as zero. */
export function decodeUint(r: HistResult | undefined): bigint {
  if (!r || !r.success || r.data.length < 66) return 0n;
  return BigInt(r.data.slice(0, 66));
}

export function hasWord(r: HistResult | undefined): boolean {
  return !!r && r.success && r.data.length >= 66;
}
