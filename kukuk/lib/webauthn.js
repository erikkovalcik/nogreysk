'use strict';
// Minimálne overovanie WebAuthn (passkey) – Face ID / Touch ID potvrdenie schválenia.
// Registrácia používa response.getPublicKey() (SPKI DER), takže netreba CBOR parser.

const crypto = require('node:crypto');
const { fromB64u } = require('./webpush');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

function parseClientData(clientDataJSON) {
  const raw = fromB64u(clientDataJSON);
  return { raw, data: JSON.parse(raw.toString('utf8')) };
}

function checkOrigin(origin) {
  const url = new URL(origin);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local) throw new Error('Passkey vyžaduje HTTPS');
  return url.hostname;
}

function verifyRegistration({ id, publicKey, clientDataJSON }, expectedChallenge) {
  const { data } = parseClientData(clientDataJSON);
  if (data.type !== 'webauthn.create') throw new Error('Nesprávny typ registrácie');
  if (!expectedChallenge || data.challenge !== expectedChallenge) throw new Error('Neplatná výzva (challenge)');
  const rpId = checkOrigin(data.origin);
  const key = crypto.createPublicKey({ key: fromB64u(publicKey), format: 'der', type: 'spki' });
  if (!['ec', 'rsa'].includes(key.asymmetricKeyType)) throw new Error('Nepodporovaný typ kľúča');
  if (!id || typeof id !== 'string') throw new Error('Chýba ID kľúča');
  return { id, publicKey, rpId, signCount: 0, createdAt: Date.now() };
}

function verifyAssertion({ id, authenticatorData, clientDataJSON, signature }, credential, expectedChallenge) {
  if (!credential) throw new Error('Zariadenie nemá passkey');
  if (id !== credential.id) throw new Error('Neznámy passkey');
  const { raw, data } = parseClientData(clientDataJSON);
  if (data.type !== 'webauthn.get') throw new Error('Nesprávny typ overenia');
  if (!expectedChallenge || data.challenge !== expectedChallenge) throw new Error('Neplatná výzva (challenge)');
  if (checkOrigin(data.origin) !== credential.rpId) throw new Error('Iná doména ako pri registrácii');

  const authData = fromB64u(authenticatorData);
  if (authData.length < 37) throw new Error('Poškodené authenticatorData');
  if (!authData.subarray(0, 32).equals(sha256(credential.rpId))) throw new Error('Nesedí rpId');
  const flags = authData[32];
  if (!(flags & 0x01)) throw new Error('Chýba prítomnosť používateľa');
  if (!(flags & 0x04)) throw new Error('Chýba overenie biometriou (odtlačok / Face ID)');
  const signCount = authData.readUInt32BE(33);
  if (signCount !== 0 && credential.signCount !== 0 && signCount <= credential.signCount) {
    throw new Error('Podozrivé počítadlo podpisov');
  }

  const key = crypto.createPublicKey({ key: fromB64u(credential.publicKey), format: 'der', type: 'spki' });
  const ok = crypto.verify('sha256', Buffer.concat([authData, sha256(raw)]), key, fromB64u(signature));
  if (!ok) throw new Error('Neplatný podpis');
  credential.signCount = signCount;
  return true;
}

module.exports = { verifyRegistration, verifyAssertion, sha256 };
