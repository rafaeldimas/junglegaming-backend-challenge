import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000000_Initial extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20, 2) not null default 0,
        version integer not null default 1,
        created_at timestamptz(3) not null,
        updated_at timestamptz(3) not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(64) not null,
        external_transaction_id varchar(191) not null,
        idempotency_key varchar(191) not null,
        payload_hash char(64) not null,
        origin varchar(16) not null,
        correlation_id varchar(128) not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id varchar(191) not null,
        game_id varchar(191) not null,
        kind varchar(16) not null,
        status varchar(24) not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(191),
        reference_transaction_id uuid references wager_transactions (id),
        failure_code varchar(48),
        balance_after numeric(20, 2),
        wallet_version_after integer,
        pending_reference_attempts integer not null default 0,
        next_reference_retry_at timestamptz(3),
        created_at timestamptz(3) not null,
        processed_at timestamptz(3),
        updated_at timestamptz(3) not null,
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transactions_provider_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_transactions_origin_check check (origin in ('INTERNAL', 'API', 'SQS')),
        constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_check check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_positive check (amount > 0),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_opening_internal check (kind <> 'OPENING' or origin = 'INTERNAL'),
        constraint wager_transactions_reference_required check (
          kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint wager_transactions_reference_not_self check (
          reference_external_transaction_id is null or reference_external_transaction_id <> external_transaction_id
        ),
        constraint wager_transactions_failure_code_required check (
          status not in ('REJECTED', 'FAILED') or failure_code is not null
        ),
        constraint wager_transactions_balance_after_non_negative check (balance_after is null or balance_after >= 0),
        constraint wager_transactions_wallet_version_positive check (wallet_version_after is null or wallet_version_after >= 1),
        constraint wager_transactions_pending_attempts_non_negative check (pending_reference_attempts >= 0)
      );
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction varchar(8) not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        created_at timestamptz(3) not null,
        constraint wallet_ledger_entries_transaction_unique unique (transaction_id),
        constraint wallet_ledger_entries_direction_check check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_math check (
          (direction = 'DEBIT' and balance_before - amount = balance_after)
          or (direction = 'CREDIT' and balance_before + amount = balance_after)
        )
      );
    `);

    this.addSql(`
      create table inbox_messages (
        id uuid primary key,
        message_id varchar(191) not null,
        consumer_name varchar(128) not null,
        payload_hash char(64) not null,
        received_at timestamptz(3) not null,
        processed_at timestamptz(3),
        constraint inbox_messages_consumer_message_unique unique (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(64) not null,
        payload jsonb not null,
        occurred_at timestamptz(3) not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz(3),
        published_at timestamptz(3),
        constraint outbox_messages_attempts_non_negative check (attempts >= 0)
      );
    `);

    // A reference may be reverted only once per operation kind (REFUND once,
    // ROLLBACK once). Only committed (PROCESSED) rows participate, so a rejected
    // attempt never blocks a later valid one.
    this.addSql(`
      create unique index wager_transactions_reversal_per_kind_unique
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and reference_transaction_id is not null;
    `);

    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_retry_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index wager_transactions_wallet_idx on wager_transactions (wallet_id, created_at);
    `);
    this.addSql(`
      create index wallet_ledger_entries_wallet_page_idx
        on wallet_ledger_entries (wallet_id, created_at, id);
    `);
    this.addSql(`
      create index outbox_messages_pending_idx on outbox_messages (occurred_at) where published_at is null;
    `);

    // Structural immutability of the ledger: UPDATE and DELETE are rejected by
    // the database, not only by convention in the application.
    this.addSql(`
      create or replace function prevent_ledger_entry_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (attempted % on %)', tg_op, tg_table_name;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function prevent_ledger_entry_mutation();
    `);
  }

  override down(): void {
    this.addSql(
      `drop trigger if exists wallet_ledger_entries_immutable on wallet_ledger_entries;`,
    );
    this.addSql(`drop function if exists prevent_ledger_entry_mutation();`);
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
  }
}
