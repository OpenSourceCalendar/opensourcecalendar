import { useEffect, useState, type FormEvent } from "react";
import type { PageProps } from "./AdminApp";
import { adminApi, adminErrorText, fullName, type Customer, type CustomerInput } from "./api";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

export const initials = (c: { first_name: string; last_name: string }) =>
  (c.first_name.charAt(0) + c.last_name.charAt(0)).toUpperCase() || "?";

export function Customers({ notify, navigate }: PageProps) {
  const [query, setQuery] = useState("");
  const [list, setList] = useState<Customer[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () => {
        adminApi.customers(query.trim()).then(
          (r) => live && (setList(r.customers), setError("")),
          (e) => live && setError(adminErrorText(e)),
        );
      },
      query ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  // A search result isn't sorted by the server, so put delete requests first here too.
  const rows = list && [...list].sort((a, b) => Number(!a.delete_requested_at) - Number(!b.delete_requested_at));

  return (
    <>
      <header className="page-head admin-band">
        <h1 className="admin-title">Customers</h1>
        <button type="button" className="btn btn-primary btn-auto" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          Add customer
        </button>
      </header>

      <input
        className="input"
        type="search"
        placeholder="Search by name, phone or email"
        aria-label="Search customers"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {!rows ? (
        !error && <span className="skeleton block" />
      ) : rows.length ? (
        <section className="card">
          <ul className="rows">
            {rows.map((c) => (
              <li key={c.id}>
                <button type="button" className="row" onClick={() => navigate(`/admin/customers/${encodeURIComponent(c.id)}`)}>
                  <span className="avatar" aria-hidden="true">
                    {initials(c)}
                  </span>
                  <span className="row-main">
                    <strong>{fullName(c)}</strong>
                    <span className="muted small">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                  </span>
                  {c.delete_requested_at && <span className="badge badge-cancelled">Asked to delete their data</span>}
                </button>
              </li>
            ))}
          </ul>
          {!query.trim() && rows.length >= 50 && <p className="muted small">Showing the 50 newest. Search to find others.</p>}
        </section>
      ) : (
        <div className="admin-empty">
          {query.trim() ? (
            <p className="sub">No customers match.</p>
          ) : (
            <>
              <p className="sub">No customers yet</p>
              <p className="muted small">Customers appear here after they book, or add one yourself.</p>
            </>
          )}
        </div>
      )}

      {adding && (
        <CustomerDialog
          onClose={() => setAdding(false)}
          onSaved={(customer, created) => {
            setAdding(false);
            notify({ text: created ? "Customer added" : "That customer already exists" });
            navigate(`/admin/customers/${encodeURIComponent(customer.id)}`);
          }}
        />
      )}
    </>
  );
}

/** Add a customer, or edit one when `customer` is given. */
export function CustomerDialog({
  customer,
  onClose,
  onSaved,
}: {
  customer?: Customer;
  onClose: () => void;
  onSaved: (customer: Customer, created: boolean) => void;
}) {
  const [form, setForm] = useState({
    first_name: customer?.first_name ?? "",
    last_name: customer?.last_name ?? "",
    phone: customer?.phone ?? "",
    email: customer?.email ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const phone = form.phone.trim();
  const email = form.email.trim();
  const ready = !!form.first_name.trim() && (!!phone || !!email);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      if (customer) {
        // Editing: null clears a field. The server refuses empty strings.
        const patch: Partial<CustomerInput> = { first_name: form.first_name.trim(), last_name: form.last_name.trim(), phone: phone || null, email: email || null };
        onSaved(await adminApi.updateCustomer(customer.id, patch), false);
      } else {
        // Adding: leave empty fields out. Never invent an email.
        const input: CustomerInput = { first_name: form.first_name.trim(), ...(form.last_name.trim() && { last_name: form.last_name.trim() }), ...(phone && { phone }), ...(email && { email }) };
        const res = await adminApi.createCustomer(input);
        onSaved(res.customer, res.created);
      }
    } catch (err) {
      setError(adminErrorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog kind="modal" title={customer ? "Edit customer" : "Add customer"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <div className="field">
            <label className="label" htmlFor="cu-first">
              First name
            </label>
            <input id="cu-first" className="input" autoComplete="off" maxLength={100} value={form.first_name} onChange={set("first_name")} />
          </div>
          <div className="field">
            <label className="label" htmlFor="cu-last">
              Last name <span className="opt">(optional)</span>
            </label>
            <input id="cu-last" className="input" autoComplete="off" maxLength={100} value={form.last_name} onChange={set("last_name")} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="cu-phone">
            Phone
          </label>
          <input id="cu-phone" className="input" type="tel" autoComplete="off" maxLength={40} value={form.phone} onChange={set("phone")} />
        </div>
        <div className="field">
          <label className="label" htmlFor="cu-email">
            Email
          </label>
          <input id="cu-email" className="input" type="email" autoComplete="off" maxLength={254} value={form.email} onChange={set("email")} />
        </div>
        <p className="hint">A phone or an email is needed.</p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {busy ? "Saving…" : customer ? "Save" : "Add customer"}
        </button>
      </form>
    </Dialog>
  );
}
