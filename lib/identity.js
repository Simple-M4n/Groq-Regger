// Deterministic-free identity generation for non-interactive registration.
// No external dependencies; values are generated locally and never logged.

import { randomBytes, randomUUID } from 'node:crypto';

const FIRST = [
  'Alex', 'Jordan', 'Morgan', 'Casey', 'Riley', 'Taylor', 'Jamie', 'Avery',
  'Quinn', 'Skyler', 'Robin', 'Cameron', 'Drew', 'Reese', 'Parker', 'Bailey',
];
const LAST = [
  'Stone', 'River', 'Chen', 'Morgan', 'Brooks', 'Hayes', 'Lane', 'Parker',
  'Reed', 'Bennett', 'Carter', 'Foster', 'Graham', 'Hughes', 'Turner', 'Wells',
];
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_';

const pick = (list) => list[randomBytes(1)[0] % list.length];

export function randomPassword(len = 16) {
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += PASSWORD_ALPHABET[buf[i] % PASSWORD_ALPHABET.length];
  return out;
}

export function makeIdentity() {
  const first = pick(FIRST);
  const last = pick(LAST);
  const suffix = randomBytes(3).toString('hex');
  return {
    first_name: first,
    last_name: last,
    local_part: `${first.toLowerCase()}.${last.toLowerCase()}${suffix}`,
    password: randomPassword(),
    uuid: randomUUID(),
    ts: String(Date.now()),
  };
}
