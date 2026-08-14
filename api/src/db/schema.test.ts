import {getTableConfig} from 'drizzle-orm/pg-core';
import {describe, expect, it} from 'vitest';
import {activity, cursors, intents, merchants} from './schema.js';

describe('merchants table', () => {
  const config = getTableConfig(merchants);

  it('is named merchants', () => {
    expect(config.name).toBe('merchants');
  });

  it('has privyDid as the primary key', () => {
    expect(config.primaryKeys).toHaveLength(0); // single-column PK is on the column itself
    expect(merchants.privyDid.primary).toBe(true);
    expect(merchants.privyDid.name).toBe('privy_did');
  });

  it('requires privyWalletId and stellarAddress', () => {
    expect(merchants.privyWalletId.notNull).toBe(true);
    expect(merchants.stellarAddress.notNull).toBe(true);
  });

  it('enforces stellarAddress uniqueness', () => {
    expect(merchants.stellarAddress.isUnique).toBe(true);
  });

  it('allows provisionedAt to be null and createdAt to default', () => {
    expect(merchants.provisionedAt.notNull).toBe(false);
    expect(merchants.createdAt.hasDefault).toBe(true);
  });
});

describe('intents table', () => {
  const config = getTableConfig(intents);

  it('is named intents', () => {
    expect(config.name).toBe('intents');
  });

  it('has a defaulted uuid primary key', () => {
    expect(intents.id.primary).toBe(true);
    expect(intents.id.hasDefault).toBe(true);
  });

  it('has a foreign key on privyDid referencing merchants', () => {
    expect(config.foreignKeys).toHaveLength(1);
    const [fk] = config.foreignKeys;
    const reference = fk!.reference();
    expect(getTableConfig(reference.foreignTable).name).toBe('merchants');
    expect(reference.columns.map((c) => c.name)).toEqual(['privy_did']);
  });

  it('requires kind, xdr, hashHex and status, defaulting status to pending', () => {
    expect(intents.kind.notNull).toBe(true);
    expect(intents.xdr.notNull).toBe(true);
    expect(intents.hashHex.notNull).toBe(true);
    expect(intents.status.notNull).toBe(true);
    expect(intents.status.default).toBe('pending');
  });

  it('allows resultTxHash, error and metadata to be null', () => {
    expect(intents.resultTxHash.notNull).toBe(false);
    expect(intents.error.notNull).toBe(false);
    expect(intents.metadata.notNull).toBe(false);
  });

  it('stores metadata as jsonb', () => {
    expect(intents.metadata.dataType).toBe('json');
    expect(intents.metadata.columnType).toBe('PgJsonb');
  });
});

describe('activity table', () => {
  const config = getTableConfig(activity);

  it('is named activity', () => {
    expect(config.name).toBe('activity');
  });

  it('requires stellarAddress, type, status and source', () => {
    expect(activity.stellarAddress.notNull).toBe(true);
    expect(activity.type.notNull).toBe(true);
    expect(activity.status.notNull).toBe(true);
    expect(activity.source.notNull).toBe(true);
  });

  it('allows direction, amount, asset fields, counterparty, txHash and externalRef to be null', () => {
    expect(activity.direction.notNull).toBe(false);
    expect(activity.amount.notNull).toBe(false);
    expect(activity.assetCode.notNull).toBe(false);
    expect(activity.assetIssuer.notNull).toBe(false);
    expect(activity.counterparty.notNull).toBe(false);
    expect(activity.txHash.notNull).toBe(false);
    expect(activity.externalRef.notNull).toBe(false);
  });

  it('indexes stellarAddress and txHash', () => {
    const indexNames = config.indexes.map((i) => i.config.name);
    expect(indexNames).toContain('activity_stellar_address_idx');
    expect(indexNames).toContain('activity_tx_hash_idx');
  });
});

describe('cursors table', () => {
  const config = getTableConfig(cursors);

  it('is named cursors', () => {
    expect(config.name).toBe('cursors');
  });

  it('has key as the primary key and requires value', () => {
    expect(cursors.key.primary).toBe(true);
    expect(cursors.key.name).toBe('key');
    expect(cursors.value.notNull).toBe(true);
  });
});
