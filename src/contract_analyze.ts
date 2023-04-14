import { isReady, shutdown } from 'snarkyjs';
import { NftRollupContract } from './nft_rollup/nft_rollup_contract';
import { TokenContract } from './token/token_contract';

async function run() {
  await isReady;

  console.log('start...');
  let result = NftRollupContract.analyzeMethods();
  console.log('analyze nftContract: ', JSON.stringify(result));
  //await NftRollupContract.compile();

  let result2 = TokenContract.analyzeMethods();
  console.log('analyze tokenContract: ', JSON.stringify(result2));
  //await TokenContract.compile();
  console.log('end');

  shutdown();
}

await run();
