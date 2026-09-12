import 'dotenv/config';
import { SignerClient } from 'zklighter-sdk';

const apiUrl =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

const secret =
  process.env.LIGHTER_API_SECRET ?? '';

const apiKeyIndex =
  Number(process.env.LIGHTER_API_KEY_INDEX ?? 0);

const accountIndex =
  Number(process.env.LIGHTER_ACCOUNT_INDEX ?? 746073);

if (!secret) {
  throw new Error(
    'LIGHTER_API_SECRET is not set'
  );
}

const normalizedSecret =
  secret.startsWith('0x')
    ? secret.slice(2)
    : secret;

const client =
  new SignerClient(
    apiUrl,
    normalizedSecret,
    apiKeyIndex,
    accountIndex
  );

const [
  token,
  error
] =
  client.create_auth_token_with_expiry(
    60 * 60,
    undefined,
    apiKeyIndex
  );

if (error || !token) {
  throw new Error(
    error ?? 'Auth token was not created'
  );
}

console.log(token);
