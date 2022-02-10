// Import
import { ApiPromise, WsProvider } from "@polkadot/api";
import { u8aToHex, isHex, hexToBn } from "@polkadot/util";
import { encodeAddress } from "@polkadot/util-crypto";

import { blake2AsHex } from "@polkadot/util-crypto";
import yargs from "yargs";
import writeJsonFile from "write-json-file";

const args = yargs.options({
  "parachain-id": { type: "number", demandOption: true, alias: "p" },
  "ws-provider": { type: "string", demandOption: true, alias: "w" },
  "output-dir": { type: "string", demandOption: true, alias: "o" },
  address: { type: "string", demandOption: false, alias: "a" }
}).argv;

// Construct
const wsProvider = new WsProvider(args["ws-provider"]);

async function main() {
  const api = await ApiPromise.create({ provider: wsProvider });
  const parentHash = ((await api.rpc.chain.getHeader()) as any)["parentHash"];
  const fund_info = (
    await api.query.crowdloan.funds(args["parachain-id"])
  ).toJSON();

  // Second we calculate the crowdloan key. This is composed of
  // b":child_storage:default:" + blake2_256(b"crowdloan" + trie_index as u32)
  let bytes = new TextEncoder().encode("crowdloan");
  // We allocate 4 bytes for the trie index
  let buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(fund_info["trieIndex"]);
  var array = Uint8Array.from(buf);
  var concatArray = new Uint8Array([...bytes, ...array]);
  let child_encoded_bytes = u8aToHex(
    new TextEncoder().encode(":child_storage:default:")
  );
  let crowdloan_key =
    child_encoded_bytes + blake2AsHex(concatArray, 256).substring(2);
  // let network_prefix = await api.consts.system.ss58Prefix.toNumber();
  let all_keys = (await api.rpc.childstate.getKeys(
    crowdloan_key,
    null,
    parentHash
  )) as any;

  // Third we get all the keys for that particular crowdloan key
  let json = {
    cap: isHex(fund_info["cap"])
      ? hexToBn(fund_info["cap"]).toString()
      : fund_info["cap"].toString(),
    total_raised: 0n,
    contributions: [],
    parachain_id: args["parachain-id"]
  };
  // Here we iterate over all the keys that we got for a particular crowdloan key
  const storages = await api.rpc.childstate.getStorageEntries(
    crowdloan_key,
    all_keys.map((i) => i.toHex())
  );
  for (let i = 0; i < storages.length; i++) {
    const storage = storages[i];
    if (storage.isSome) {
      let storage_item = storage.unwrap();
      // The storage item is composed as:
      // Balance (16 bytes with changed endianness)
      // 1 byte memo length
      // Memo
      let balance = BigInt(u8aToHex(storage_item.slice(0, 16).reverse()));
      let memoLenght = storage.unwrap().slice(16, 17);
      let memo = "";
      let memoHex = "";
      if (u8aToHex(memoLenght) != "0x00") {
        const hexAddress = u8aToHex(
          storage_item.slice(17, storage_item.length)
        );
        memoHex = hexAddress;
        memo = encodeAddress(hexAddress, 42);
      }

      json.contributions.push({
        kusamaAccountHex: all_keys[i].toHex(),
        kusamaAccount: encodeAddress(all_keys[i].toHex(), 2),
        contribution: balance.toString(),
        memo: memo,
        memoHex: memoHex
      });
      json.total_raised += balance;
    }
  }
  if (!args["address"]) {
    if (json.total_raised != fund_info["raised"]) {
      throw new Error(`Contributed amount and raised amount dont match`);
    }
  }
  console.log(json);
  await writeJsonFile(args["output-dir"], {
    ...json,
    total_raised: json.total_raised.toString()
  });
}
main()
  .catch(console.error)
  .finally(() => process.exit());
