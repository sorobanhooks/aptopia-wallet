import { ContractSummary } from './db';
import type { ContractNetwork } from './contract-wasm';
import { fetchAndDecodeContractWasm } from './contract-wasm';
import { summarizeContractWasmWithGemini } from './contract-summary-ai';

export async function getOrCreateContractSummary(network: ContractNetwork, contract: string) {
  const { decoded, wasmDigest } = await fetchAndDecodeContractWasm(contract, network);

  const cached = await ContractSummary.findOne({
    network,
    contract,
    wasmDigest,
  }).lean();

  if (cached) {
    return {
      source: 'cache' as const,
      network,
      contract,
      wasmDigest,
      summary: cached.summary,
      decoded,
    };
  }

  const summary = await summarizeContractWasmWithGemini(decoded);

  await ContractSummary.findOneAndUpdate(
    { network, contract, wasmDigest },
    {
      $set: {
        network,
        contract,
        wasmDigest,
        summary,
      },
    },
    { upsert: true, new: true }
  );

  return {
    source: 'fresh' as const,
    network,
    contract,
    wasmDigest,
    summary,
    decoded,
  };
}
