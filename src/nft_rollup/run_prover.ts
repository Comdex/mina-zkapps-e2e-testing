import { MerkleTree } from 'snarky-smt';
import { Field } from 'snarkyjs';
import { fetchActions } from 'snarkyjs/dist/node/lib/fetch';
import { Action, NFT, RollupState, ActionBatch } from './model';
import { NftRollupContract } from './nft_rollup_contract';
import {
  NftRollupProof,
  NftRollupProverHelper,
  NftRollupProver,
} from './rollup_prover';

export { getPendingActions, runRollupBatchProve };

function getPendingActions(
  zkapp: NftRollupContract,
  fromActionHash: Field,
  endActionHash?: Field
): Action[] {
  let pendingActions = zkapp.reducer.getActions({
    fromActionHash,
    endActionHash,
  });
  let actions: Action[] = [];

  pendingActions.forEach((actionList) => {
    actionList.forEach((action) => {
      actions.push(action);
    });
  });

  return actions;
}

async function runRollupBatchProve(
  zkapp: NftRollupContract,
  offchainStorage: MerkleTree<NFT>,
  deployToBerkeley = false
): Promise<NftRollupProof | null> {
  console.log('run rollup batch prove start');
  console.time('run rollup batch prove');

  let currentState: RollupState;
  if (deployToBerkeley) {
    let fetchedState = await zkapp.state.fetch();
    if (fetchedState === undefined) {
      throw new Error('currentState is undefined');
    }

    currentState = fetchedState;
  } else {
    currentState = zkapp.state.get();
  }
  console.log(
    `rollup-current state - currentActionsHash: ${currentState.currentActionsHash}, currentIndex: ${currentState.currentIndex}, nftsCommitment: ${currentState.nftsCommitment}`
  );

  if (deployToBerkeley) {
    await fetchActions({ publicKey: zkapp.address.toBase58() });
  }
  let pendingActions = getPendingActions(
    zkapp,
    currentState.currentActionsHash
  );
  console.log('rollup-pendingActions: ', pendingActions);
  if (pendingActions.length === 0) {
    return null;
  }

  let proofs: NftRollupProof[] = [];
  let currState = currentState;

  let batchNum = pendingActions.length / ActionBatch.batchSize;
  let restActionsNum = pendingActions.length % ActionBatch.batchSize;

  let curPos = 0;
  for (let i = 0; i < batchNum; i++) {
    let currentActions = pendingActions.slice(
      curPos,
      curPos + ActionBatch.batchSize
    );
    curPos = curPos + ActionBatch.batchSize;

    let { stateTransition, actionBatch } =
      await NftRollupProverHelper.commitActionBatch(
        currentActions,
        currState,
        offchainStorage
      );

    console.log('stateTransition: ', stateTransition.toPretty());

    console.time('generate commitActionBatch proof');
    let currProof = await NftRollupProver.commitActionBatch(
      stateTransition,
      actionBatch
    );
    console.timeEnd('generate commitActionBatch proof');

    proofs.push(currProof);
    currState = stateTransition.target;
  }

  // process rest actions
  if (restActionsNum > 0) {
    console.log('process rest actions');
    let { stateTransition, actionBatch } =
      await NftRollupProverHelper.commitActionBatch(
        pendingActions.slice(curPos, curPos + restActionsNum),
        currState,
        offchainStorage
      );

    console.log('stateTransition: ', stateTransition.toPretty());

    console.time('generate commitActionBatch proof');
    let currProof = await NftRollupProver.commitActionBatch(
      stateTransition,
      actionBatch
    );
    console.timeEnd('generate commitActionBatch proof');

    proofs.push(currProof);
  }

  let mergedProof = proofs[0];
  if (proofs.length > 1) {
    for (let i = 1, len = proofs.length; i < len; i++) {
      let p1 = mergedProof;
      let p2 = proofs[i];
      let stateTransition = NftRollupProverHelper.merge(p1, p2);
      console.time('generate merged proof');
      mergedProof = await NftRollupProver.merge(stateTransition, p1, p2);
      console.timeEnd('generate merged proof');
    }
  }

  console.timeEnd('run rollup batch prove');

  console.log('run rollup batch prove end');
  return mergedProof;
}
