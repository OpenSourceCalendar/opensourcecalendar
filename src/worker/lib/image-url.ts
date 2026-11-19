/** Where the public image route serves a stored image. Lives here, not in routes/images.ts, so account code can use it
 * without importing that router (which imports auth.ts: an import cycle). */
export const imageUrl = (key: string | null) => (key ? `/api/public/images/${key}` : null);
