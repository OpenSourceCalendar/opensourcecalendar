import { z } from "zod";

const REQUIRED_FIELDS_DEFAULT = { first_name: true, last_name: false, email: false, phone: true };

export const RulesSchema = z.object({
  buffer_min: z.literal([0, 15, 30]).default(0),
  max_per_day: z.number().int().min(1).max(200).nullable().default(null),
  min_notice_min: z.number().int().min(0).max(60 * 24 * 60).default(60),
  max_days_ahead: z.number().int().min(1).max(730).default(90),
  change_cutoff_hours: z.number().int().min(0).max(24 * 60).default(0),
  slot_step_min: z.literal([5, 10, 15, 20, 30, 60]).default(15),
  required_fields: z
    .object({ first_name: z.boolean(), last_name: z.boolean(), email: z.boolean(), phone: z.boolean() })
    .refine((f) => f.email || f.phone, { message: "phone or email must be required" })
    .default(REQUIRED_FIELDS_DEFAULT),
  cancel_reason_required: z.boolean().default(false),
  block_all_day_google: z.boolean().default(true),
  powered_by: z.boolean().default(true),
});

export const BrandingSchema = z.object({
  business_name: z.string().max(100).default(""),
  phone: z.string().max(40).default(""),
  tagline: z.string().max(200).default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2d6a4f"),
  logo_key: z.string().max(200).nullable().default(null),
  hero_key: z.string().max(200).nullable().default(null),
});

export const NotificationsSchema = z.object({
  customer_confirmation: z.boolean().default(true),
  customer_change: z.boolean().default(true),
  customer_cancel: z.boolean().default(true),
  owner_new: z.boolean().default(true),
  owner_change: z.boolean().default(true),
  owner_cancel: z.boolean().default(true),
  reminder: z.boolean().default(true),
  /** smart = 1–2 hours before; early-morning appointments get it ~6 PM the evening before. */
  reminder_mode: z.enum(["smart", "hours_before"]).default("smart"),
  reminder_hours_before: z.number().int().min(1).max(168).default(24),
  /** Where the owner's booking emails go. Empty = none. */
  owner_email: z.union([z.literal(""), z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)]).default(""),
  confirmation_message: z
    .string()
    .max(160)
    .default("Thanks for booking with [Business Name]. See you [Date] at [Time] for [Service]."),
});

export type Rules = z.output<typeof RulesSchema>;
export type Branding = z.output<typeof BrandingSchema>;
export type Notifications = z.output<typeof NotificationsSchema>;

const fromJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

export const parseRules = (stored: string): Rules => RulesSchema.parse(fromJson(stored));
export const parseBranding = (stored: string): Branding => BrandingSchema.parse(fromJson(stored));
export const parseNotifications = (stored: string): Notifications => NotificationsSchema.parse(fromJson(stored));

/** Shallow-merge `patch` over the stored value and re-validate. Nested objects are replaced whole. */
function merge<S extends z.ZodType>(schema: S, stored: string, patch: unknown) {
  const base = fromJson(stored);
  const next = { ...(base as object), ...(patch as object) };
  return schema.safeParse(next);
}

export const mergeRules = (stored: string, patch: unknown) => merge(RulesSchema, stored, patch);
export const mergeBranding = (stored: string, patch: unknown) => merge(BrandingSchema, stored, patch);
export const mergeNotifications = (stored: string, patch: unknown) => merge(NotificationsSchema, stored, patch);
