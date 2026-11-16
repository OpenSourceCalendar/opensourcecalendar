export function NotFound({ message = "This link doesn't go anywhere. Check the address and try again." }: { message?: string }) {
  return (
    <div className="page">
      <main className="sheet content">
        <h1 className="title">Page not found</h1>
        <p className="muted">{message}</p>
      </main>
    </div>
  );
}
