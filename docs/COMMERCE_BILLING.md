# Custom strategy orders, support and YooKassa

Strategy Lab remains a free trading laboratory. The commerce layer adds only two one-time payment purposes:

- `CUSTOM_STRATEGY` — individual implementation of a user's trading strategy after an administrator reviews the request and sets a quote;
- `SUPPORT` — voluntary one-time support of Strategy Lab.

There are no plans, subscriptions, entitlements, recurring charges or paywalls.

## Storage / migration

On application startup `auth_routes.configure()` initializes `storage/commerce.db`. The migration is additive only:

- creates `custom_strategy_orders`;
- creates `payments`;
- creates `private_strategies`;
- creates `admin_audit_log`;
- creates indexes, including a partial unique index preventing two concurrent `PENDING` payments for one custom-strategy order.

No existing Strategy Lab table is dropped or recreated. `deploy/update.sh` already backs up the entire `storage/` directory before restart, so `commerce.db` is included automatically after its first creation.

## Production environment

Set in `/opt/moex-strategy-lab-v3/.env` (never commit real values):

```env
BILLING_PROVIDER=yookassa
YOOKASSA_SHOP_ID=<shop id>
YOOKASSA_SECRET_KEY=<secret key>
YOOKASSA_RETURN_URL=https://strategylab.generationweb.ru/account/payments/result
```

For local development/tests leave `BILLING_PROVIDER=mock` and do not set YooKassa credentials.

## YooKassa webhook

Configure this exact URL in YooKassa:

```text
https://strategylab.generationweb.ru/api/billing/yookassa/webhook
```

Events handled:

- `payment.succeeded`
- `payment.canceled`

The return URL is UX only and never marks a payment successful. For the real YooKassa provider, every relevant webhook is verified by an authenticated server-to-server `GET /v3/payments/{id}` call. The backend then verifies remote payment id, amount, currency and metadata before changing local state. Pending payments are also synchronised server-side when the user returns from checkout.

## Idempotency

A local `Payment` is created before contacting YooKassa and owns a stable `idempotency_key`. Retrying checkout reuses the same pending row and therefore the same YooKassa `Idempotence-Key`. A partial unique index prevents two concurrent pending custom-strategy payments for the same order.

Repeated `payment.succeeded` / `payment.canceled` events are safe. `payment.succeeded` only advances an order from `WAITING_PAYMENT` to `PAID`; a delayed callback cannot regress `IN_PROGRESS`, `READY` or `COMPLETED` back to `PAID`.

## Admin access

The existing additive `users.is_admin` flag is the single source of truth. All `/admin/*` and `/api/admin/*` routes use the reusable `auth.admin_required` server-side guard.

There is deliberately no hard-coded admin email. Promote the intended owner once on the VPS using the existing user database, for example after replacing the email placeholder:

```bash
cd /opt/moex-strategy-lab-v3
sqlite3 storage/users.db "UPDATE users SET is_admin=1 WHERE email='OWNER_EMAIL';"
```

Verify exactly one intended account is an admin:

```bash
sqlite3 storage/users.db "SELECT id,email,display_name,is_admin FROM users WHERE is_admin=1;"
```

## Private strategy implementation flow

The order does not automatically generate code. After payment the developer implements/registers the strategy runner in the normal Strategy Lab strategy engine. In Admin, `Привязать стратегию` links the order to that registered runner and creates a `private_strategies` alias owned by the customer.

The private alias is returned only to its owner or an admin. Portfolio assignment endpoints enforce ownership server-side. At backtest start the alias is resolved to its registered runner and the request is handed to the existing backtest engine; no second backtest engine exists.

Existing `STRATEGY_CATALOG` strategies remain public/system strategies and keep their previous behavior.

## Attachments

`attachments_json` is reserved in the order schema, but uploads are intentionally not exposed in the first version. Strategy Lab currently has no general private attachment storage/serving layer; adding a public file endpoint just for this feature would unnecessarily widen the attack surface. A future implementation can add whitelisted `png/jpg/jpeg/pdf/txt` storage outside executable directories without changing the order schema.

## Privacy / analytics

The trading rules, free-form strategy description, contact details, admin notes and provider payload are never sent to Yandex Metrika. Product analytics use only safe event names and coarse metadata such as source, amount and selected option counts.
