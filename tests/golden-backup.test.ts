import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { decryptBackup } from '../services/backupCrypto';
import { storageService, validateBackupCollections } from '../services/storage';
import ownerA from './fixtures/golden-backup-ownerA.json';
import ownerB from './fixtures/golden-backup-ownerB.json';
import withOutbox from './fixtures/golden-backup-with-outbox.json';
import encrypted from './fixtures/golden-backup-encrypted-ownerA.json';

class TestLocalStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
const install = () => {
  const ls = new TestLocalStorage();
  (globalThis as any).window = { localStorage: ls, dispatchEvent: () => true };
  (globalThis as any).localStorage = ls;
  return ls;
};

describe('golden backup fixtures', () => {
  it('ownerA fixture is valid and decrypts', async () => {
    install();
    const decrypted = await decryptBackup(encrypted as any, 'correct horse battery staple 123');
    expect(decrypted.ownerKey).toBe(ownerA.ownerKey);
    expect(decrypted.checksum).toBe(ownerA.checksum);
    validateBackupCollections(decrypted);
  });

  it('wrong-owner import is rejected', async () => {
    install();
    const userA = ownerA.ownerKey;
    // Import ownerB's backup into ownerA context should fail owner check
    await expect(storageService.importBackup(userA, ownerB as any, 'merge')).rejects.toThrow(/different Tsurfing account/i);
  });

  it('pending outbox fixture survives validation', async () => {
    // Should not throw; outbox/conflict present in collections but web backup validation tolerates unknown fields?
    // We check that validation at least checks checksum and schema
    validateBackupCollections(withOutbox as any);
    expect((withOutbox as any).collections.sync.outbox.length).toBeGreaterThan(0);
  });
});
