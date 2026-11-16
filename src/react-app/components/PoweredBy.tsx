export function PoweredBy({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <footer className="powered">
      <a href="https://opensourcecalendar.com" target="_blank" rel="noopener">
        <img src="/favicon.svg" width="16" height="16" alt="" />
        Powered by Open Source Calendar
      </a>
    </footer>
  );
}
