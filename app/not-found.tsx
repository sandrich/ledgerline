import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="empty">
      <i className="ph ph-compass" aria-hidden="true" />
      <b>Page not found</b>
      <Link className="btn" href="/">
        Back to the overview
      </Link>
    </div>
  );
}
