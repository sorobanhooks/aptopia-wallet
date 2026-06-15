const { default: fetch } = require("node-fetch");

async function run() {
  console.log("Fetching recent contracts...");
  let cursor = null;
  let count = 0;
  
  while (count < 200) {
    const url = `https://api.stellar.expert/explorer/testnet/contract?sort=created&order=desc&limit=50${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (!data._embedded || !data._embedded.records) break;
    
    for (const record of data._embedded.records) {
      count++;
      const cid = record.contract;
      
      // Try to ask Soroban RPC if the contract has token_uri
      try {
        const body = {
          jsonrpc: "2.0",
          id: 1,
          method: "getLedgerEntries",
          params: {
              keys: [{
                 "contractData": {
                    "contract": {"contractId": cid},
                    "key": {"symbol": "token_uri"} // Depending on how token_uri is stored, this might not work if it's not a generic map key.
                 }
              }]
          }
        };
        const rpcRes = await fetch("https://soroban-testnet.stellar.org:443/", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(body)
        });
        const rpcData = await rpcRes.json();
        // This is not standard but we could just try.
      } catch (e) {}
    }
    cursor = data._links.next.href.split("cursor=")[1];
  }
}
run();
