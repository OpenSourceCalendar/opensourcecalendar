import { AdminApp } from "./admin/AdminApp";
import { BookingPage } from "./pages/BookingPage";
import { ManagePage } from "./pages/ManagePage";
import { NotFound } from "./pages/NotFound";

export function App() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "book" && parts[1]) return <BookingPage slug={decodeURIComponent(parts[1])} />;
  if (parts[0] === "m" && parts[1]) return <ManagePage token={decodeURIComponent(parts[1])} />;
  if (parts[0] === "admin") return <AdminApp />;
  return <NotFound />;
}
