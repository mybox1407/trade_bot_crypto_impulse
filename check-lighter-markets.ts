import axios from 'axios';

const baseUrl =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

async function main() {
  const response = await axios.get(
    `${baseUrl}/api/v1/orderBookDetails`
  );

  console.dir(response.data, { depth: null });
}

main().catch(error => {
  console.error(
    error.response?.data ??
      (error instanceof Error ? error.message : error)
  );

  process.exit(1);
});
