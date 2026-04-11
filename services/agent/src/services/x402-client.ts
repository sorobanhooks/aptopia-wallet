import { x402Client, x402HTTPClient } from '@x402/fetch';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { config } from '../config';

const XLM_TOKEN = 'XLM';

export async function fetchPrice(agentSecret: string): Promise<any> {
  const proxyUrl = `http://localhost:${process.env.PORT || 3000}/api/v1/alerts/${XLM_TOKEN}`;
  const network = config.network as `${string}:${string}`;
  const signer = createEd25519Signer(agentSecret, network);
  const client = new x402Client().register(
    'stellar:*',
    new ExactStellarScheme(signer)
  );
  const httpClient = new x402HTTPClient(client);

  const firstTry = await fetch(proxyUrl);
  if (firstTry.status !== 402) {
    if (!firstTry.ok) {
      throw new Error(`Price request failed with status ${firstTry.status}`);
    }
    return firstTry.json();
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse((name) =>
    firstTry.headers.get(name)
  );
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paidResponse = await fetch(proxyUrl, {
    method: 'GET',
    headers: paymentHeaders,
  });

  if (!paidResponse.ok) {
    const bodyText = await paidResponse.text();
    throw new Error(
      `Paid request failed with status ${paidResponse.status}: ${bodyText}`
    );
  }

  return paidResponse.json();
}
