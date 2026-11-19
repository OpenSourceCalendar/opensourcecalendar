import { AdminApp } from "./admin/AdminApp";
import { ClientLoginPage, InvitePage, LoginPage, SignupPage, VerifyPage } from "./pages/AccountPages";
import { BookingPage } from "./pages/BookingPage";
import { ManagePage } from "./pages/ManagePage";
import { NotFound } from "./pages/NotFound";

export function App() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "book" && parts[1]) return <BookingPage slug={decodeURIComponent(parts[1])} />;
  if (parts[0] === "m" && parts[1]) return <ManagePage token={decodeURIComponent(parts[1])} />;
  if (parts[0] === "admin") return <AdminApp />;
  if (parts[0] === "signup") return <SignupPage />;
  if (parts[0] === "login") {
    if (parts[1] === "verify") return <VerifyPage />;
    if (parts[1] && parts[2] === "verify") return <VerifyPage slug={decodeURIComponent(parts[1])} />;
    if (parts[1]) return <ClientLoginPage slug={decodeURIComponent(parts[1])} />;
    return <LoginPage />;
  }
  if (parts[0] === "invite") return <InvitePage />;
  return <NotFound />;
}
