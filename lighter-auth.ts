import dotenv from 'dotenv';
import { SignerClient } from 'zklighter-sdk';

dotenv.config();

const apiUrl =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const apiKeySecret =
  process.env.LIGHTER_API_SECRET ?? '';

const apiKeyIndex =
  Number(
    process.env.LIGHTER_API_KEY_INDEX ?? 0
  );

const accountIndex =
  Number(
    process.env.LIGHTER_ACCOUNT_INDEX ?? 746073
  );

if (!apiKeySecret) {
  throw new Error(
    'LIGHTER_API_SECRET is not set'
  );
}

if (
  !Number.isInteger(apiKeyIndex) ||
  apiKeyIndex < 0 ||
  apiKeyIndex > 254
) {
  throw new Error(
    `Invalid LIGHTER_API_KEY_INDEX: ${apiKeyIndex}`
  );
}

if (
  !Number.isInteger(accountIndex) ||
  accountIndex < 0
) {
  throw new Error(
    `Invalid LIGHTER_ACCOUNT_INDEX: ${accountIndex}`
  );
}

const normalizedKey =
  apiKeySecret.startsWith('0x')
    ? apiKeySecret.slice(2)
    : apiKeySecret;

const signerClient =
  new SignerClient(
    apiUrl,
    normalizedKey,
    apiKeyIndex,
    accountIndex
  );

const [
  authToken,
  authError
] =
  signerClient.create_auth_token_with_expiry(
    60 * 60,
    undefined,
    apiKeyIndex
  );

if (authError || !authToken) {
  throw new Error(
    authError ??
      'Failed to create Lighter auth token'
  );
}

console.log(authToken);
