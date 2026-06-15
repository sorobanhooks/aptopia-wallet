import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';
import { rpc as StellarRpc, Contract as StellarContract } from 'stellar-sdk';

const exec = promisify(execCb);

export type ContractNetwork = 'mainnet' | 'testnet';

type WasmFunctionInfo = {
  name: string;
  params: string[];
  returnType: string | null;
};

export type DecodedContractWasm = {
  contract: string;
  network: ContractNetwork;
  interface: {
    importedFunctions: WasmFunctionInfo[];
    exportedFunctions: WasmFunctionInfo[];
    definedFunctions: WasmFunctionInfo[];
    globals: string[];
  };
};

function getRpcUrl(network: ContractNetwork): string {
  if (network === 'mainnet') {
    return process.env.STELLAR_MAINNET_RPC || 'https://mainnet.sorobanrpc.com';
  }
  return process.env.STELLAR_TESTNET_RPC || 'https://soroban-testnet.stellar.org';
}

function isValidContractAddress(address: string): boolean {
  return /^C[A-Z0-9]{55}$/.test(address);
}

function parseWatFunctions(wat: string): { definedFunctions: WasmFunctionInfo[]; globals: string[] } {
  const functionRegex = /\(func\s+(?:\$([^\s\)]+))?([^\)]*)\)/g;
  const globalRegex = /\(global\s+([^\)]+)\)/g;

  const definedFunctions: WasmFunctionInfo[] = [];
  const globals: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = functionRegex.exec(wat)) !== null) {
    const name = match[1] || `fn_${definedFunctions.length}`;
    const body = match[2] || '';
    const params = Array.from(body.matchAll(/\(param\s+([^\)]+)\)/g)).map((m) => m[1].trim());
    const returnType = body.match(/\(result\s+([^\)]+)\)/)?.[1]?.trim() ?? null;
    definedFunctions.push({ name, params, returnType });
  }

  while ((match = globalRegex.exec(wat)) !== null) {
    globals.push(match[1].trim());
  }

  return { definedFunctions, globals };
}

async function decompileWasmToWat(wasm: Buffer): Promise<string | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-wasm-'));
  const wasmFile = path.join(tmpDir, 'contract.wasm');
  const watFile = path.join(tmpDir, 'contract.wat');

  try {
    await fs.writeFile(wasmFile, wasm);
    await exec(`wasm-decompile "${wasmFile}" -o "${watFile}"`);
    return await fs.readFile(watFile, 'utf8');
  } catch {
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function computeWasmDigest(wasm: Buffer): string {
  return createHash('sha256').update(wasm).digest('hex');
}

export async function fetchAndDecodeContractWasm(
  address: string,
  network: ContractNetwork
): Promise<{ decoded: DecodedContractWasm; wasmDigest: string }> {
  if (!isValidContractAddress(address)) {
    const error = new Error('Invalid contract address format');
    (error as any).statusCode = 400;
    throw error;
  }

  const server = new StellarRpc.Server(getRpcUrl(network));
  const contract = new StellarContract(address);

  let entries;
  try {
    entries = await server.getLedgerEntries(contract.getFootprint());
  } catch (e) {
    const error = new Error('Unable to query contract on Stellar RPC');
    (error as any).statusCode = 502;
    throw error;
  }

  if (!entries.entries?.length) {
    const error = new Error(`Contract not found on ${network}`);
    (error as any).statusCode = 404;
    throw error;
  }

  let wasmBuffer: Buffer;
  try {
    wasmBuffer = await server.getContractWasmByContractId(address);
  } catch {
    const error = new Error('Unable to fetch contract WASM');
    (error as any).statusCode = 502;
    throw error;
  }

  if (!wasmBuffer.length) {
    const error = new Error('Contract WASM is empty');
    (error as any).statusCode = 502;
    throw error;
  }

  const module = new WebAssembly.Module(new Uint8Array(wasmBuffer));
  const importedFunctions = WebAssembly.Module.imports(module)
    .filter((x) => x.kind === 'function')
    .map((x) => ({ name: `${x.module}.${x.name}`, params: [], returnType: null as string | null }));

  const exportedFunctions = WebAssembly.Module.exports(module)
    .filter((x) => x.kind === 'function')
    .map((x) => ({ name: x.name, params: [], returnType: null as string | null }));

  const wat = await decompileWasmToWat(wasmBuffer);
  const { definedFunctions, globals } = wat
    ? parseWatFunctions(wat)
    : { definedFunctions: [], globals: [] };

  return {
    wasmDigest: computeWasmDigest(wasmBuffer),
    decoded: {
      contract: address,
      network,
      interface: {
        importedFunctions,
        exportedFunctions,
        definedFunctions,
        globals,
      },
    },
  };
}
