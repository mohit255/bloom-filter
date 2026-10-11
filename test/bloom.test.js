import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BloomFilter } from '../src/bloom.js';

test('sizes 10M items at 1% to ~12 MB with 7 hashes', () => {
  const bloom = BloomFilter.forCapacity(10_000_000, 0.01);
  assert.equal(bloom.hashes, 7);
  assert.equal(bloom.bits, 95_850_584);
  assert.ok(Math.abs(bloom.sizeBytes / 1024 / 1024 - 11.43) < 0.01);
});

test('never returns a false negative', () => {
  const bloom = BloomFilter.forCapacity(100_000, 0.01);
  for (let i = 0; i < 100_000; i++) bloom.add(`user_${i}`);
  for (let i = 0; i < 100_000; i++) assert.ok(bloom.mightContain(`user_${i}`), `user_${i}`);
});

test('false-positive rate stays close to the target', () => {
  const bloom = BloomFilter.forCapacity(100_000, 0.01);
  for (let i = 0; i < 100_000; i++) bloom.add(`user_${i}`);
  let fp = 0;
  for (let i = 0; i < 100_000; i++) if (bloom.mightContain(`other_${i}`)) fp++;
  const rate = fp / 100_000;
  assert.ok(rate > 0.005 && rate < 0.015, `observed FP rate ${rate}`);
});

test('handles non-ASCII and very long strings', () => {
  const bloom = BloomFilter.forCapacity(1_000, 0.01);
  const long = 'x'.repeat(2_000);
  bloom.add('मोहित');
  bloom.add(long);
  assert.ok(bloom.mightContain('मोहित'));
  assert.ok(bloom.mightContain(long));
  assert.ok(!bloom.mightContain(`${long}y`));
});

test('save/load round-trips bits and count', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bloom-')), 'test.bloom');
  const bloom = BloomFilter.forCapacity(10_000, 0.01);
  for (let i = 0; i < 5_000; i++) bloom.add(`user_${i}`);
  bloom.save(path);

  const loaded = BloomFilter.load(path);
  assert.equal(loaded.bits, bloom.bits);
  assert.equal(loaded.hashes, bloom.hashes);
  assert.equal(loaded.count, 5_000);
  assert.deepEqual(Buffer.from(loaded.data), Buffer.from(bloom.data));
});
