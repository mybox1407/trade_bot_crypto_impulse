const baseUrl =
  process.env.LIGHTER_API_URL ??
  'https://mainnet.zklighter.elliot.ai';

async function main() {
  const url = `${baseUrl}/api/v1/orderBookDetails`;

  console.log(`Request: ${url}`);

  const response = await fetch(url);

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${text}`
    );
  }

  const data = JSON.parse(text);

  console.dir(data, {
    depth: null,
    colors: false
  });
}

main().catch(error => {
  console.error(
    error instanceof Error ? error.message : error
  );

  process.exit(1);
});
