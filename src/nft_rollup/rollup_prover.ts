import {
  createEmptyValue,
  MerkleTree,
  ProvableMerkleTreeUtils,
} from 'snarky-smt';
import {
  AccountUpdate,
  Circuit,
  Experimental,
  Field,
  SelfProof,
  Struct,
} from 'snarkyjs';

import { NFT_SUPPLY } from './constants';
import {
  Action,
  ActionBatch,
  DUMMY_NFT_HASH,
  DUMMY_NFT_ID,
  MerkleProof,
  NFT,
  RollupState,
  RollupStateTransition,
} from './model';

export { NftRollupProver, NftRollupProof, NftRollupProverHelper };

class NFTResult extends Struct({ id: Field, hash: Field }) {}

function rollupStateTransform(currStateData: {
  currAction: Action;
  currMerkleProof: MerkleProof;
  currentActionsHash: Field;
  currentIndex: Field;
  currentNftsCommitment: Field;
}): {
  currentActionsHash: Field;
  currentIndex: Field;
  currentNftsCommitment: Field;
} {
  let {
    currAction,
    currMerkleProof,
    currentActionsHash,
    currentIndex,
    currentNftsCommitment,
  } = currStateData;
  // compute actions hash
  let eventHash = AccountUpdate.SequenceEvents.hash([currAction.toFields()]);
  currentActionsHash = Circuit.if(
    currAction.isDummyData(),
    currentActionsHash,
    AccountUpdate.SequenceEvents.updateSequenceState(
      currentActionsHash,
      eventHash
    )
  );

  // process mint
  let isMint = currAction.isMint();
  currentIndex = Circuit.if(
    isMint.and(currentIndex.lessThan(NFT_SUPPLY)),
    currentIndex.add(1),
    currentIndex
  );
  let mintNftHash = currAction.nft.assignId(currentIndex).hash();
  let mintResult = { id: currentIndex, hash: mintNftHash };

  // process transfer
  let isTransfer = currAction.isTransfer();
  let transferNftHash = currAction.nft.hash();
  let transferResult = {
    id: currAction.nft.id,
    hash: transferNftHash,
  };

  // process dummy data
  let isDummyData = currAction.isDummyData();
  let dummyResult = { id: DUMMY_NFT_ID, hash: DUMMY_NFT_HASH };

  let originalHashValid = ProvableMerkleTreeUtils.checkMembership(
    currMerkleProof,
    currentNftsCommitment,
    Circuit.if(isMint, currentIndex, currAction.nft.id),
    currAction.originalNFTHash,
    Field,
    { hashValue: false }
  );

  let nftResult = Circuit.switch([isMint, isTransfer, isDummyData], NFTResult, [
    Circuit.if(
      currentIndex.lessThan(NFT_SUPPLY).and(originalHashValid),
      mintResult,
      dummyResult
    ),
    Circuit.if(originalHashValid, transferResult, dummyResult),
    dummyResult,
  ]);

  Circuit.log('isProofValid: ', originalHashValid);

  currentNftsCommitment = Circuit.if(
    Circuit.equal(nftResult, dummyResult),
    currentNftsCommitment,
    ProvableMerkleTreeUtils.computeRoot(
      currMerkleProof,
      nftResult.id,
      nftResult.hash,
      Field,
      { hashValue: false }
    )
  );

  return { currentActionsHash, currentIndex, currentNftsCommitment };
}

let NftRollupProver = Experimental.ZkProgram({
  publicInput: RollupStateTransition,

  methods: {
    commitActionBatch: {
      privateInputs: [ActionBatch],

      method(stateTransition: RollupStateTransition, actionBatch: ActionBatch) {
        let prevNftsCommitment = stateTransition.source.nftsCommitment;
        let prevCurrIndex = stateTransition.source.currentIndex;
        let prevCurrActionsHash = stateTransition.source.currentActionsHash;
        let afterNfsCommitment = stateTransition.target.nftsCommitment;
        let afterCurrIndex = stateTransition.target.currentIndex;
        let afterCurrActonsHash = stateTransition.target.currentActionsHash;

        let currentActionsHash = prevCurrActionsHash;
        let currentIndex = prevCurrIndex;
        let currentNftsCommitment = prevNftsCommitment;

        for (let i = 0, len = ActionBatch.batchSize; i < len; i++) {
          let currAction = actionBatch.actions[i];
          let currMerkleProof = actionBatch.merkleProofs[i];

          let newState = rollupStateTransform({
            currAction,
            currMerkleProof,
            currentActionsHash,
            currentIndex,
            currentNftsCommitment,
          });

          currentActionsHash = newState.currentActionsHash;
          currentIndex = newState.currentIndex;
          currentNftsCommitment = newState.currentNftsCommitment;
        }

        currentActionsHash.assertEquals(
          afterCurrActonsHash,
          'currentActionsHash assertion failed'
        );

        currentIndex.assertEquals(
          afterCurrIndex,
          'currentIndex assertion failed'
        );

        currentNftsCommitment.assertEquals(
          afterNfsCommitment,
          'currentNftsCommitment assertion failed'
        );
      },
    },

    merge: {
      privateInputs: [SelfProof, SelfProof],

      method(
        stateTransition: RollupStateTransition,
        p1: SelfProof<RollupStateTransition>,
        p2: SelfProof<RollupStateTransition>
      ) {
        p1.verify();
        p2.verify();

        p1.publicInput.source.assertEquals(stateTransition.source);
        p1.publicInput.target.assertEquals(p2.publicInput.source);
        p2.publicInput.target.assertEquals(stateTransition.target);
      },
    },
  },
});

class NftRollupProof extends Experimental.ZkProgram.Proof(NftRollupProver) {}

let NftRollupProverHelper = {
  async commitActionBatch(
    actions: Action[],
    currState: RollupState,
    offchainStorage: MerkleTree<NFT>
  ): Promise<{
    stateTransition: RollupStateTransition;
    actionBatch: ActionBatch;
  }> {
    if (actions.length > ActionBatch.batchSize) {
      throw new Error(
        `Actions exceeding a fixed batch size of ${ActionBatch.batchSize} cannot be processed`
      );
    }

    let currentActionsHash = currState.currentActionsHash;
    let currentIndex = currState.currentIndex.toBigInt();
    let newMerkleProofs: MerkleProof[] = [];

    let dummyProof = createEmptyValue(MerkleProof);

    for (let i = 0, len = actions.length; i < len; i++) {
      let currAction = actions[i];

      // compute new actions hash
      let eventHash = AccountUpdate.SequenceEvents.hash([
        currAction.toFields(),
      ]);
      currentActionsHash = AccountUpdate.SequenceEvents.updateSequenceState(
        currentActionsHash,
        eventHash
      );

      let currentNftId = currAction.nft.id;
      let currentNftIdBigInt = currentNftId.toBigInt();

      // compute new current index and root
      if (currAction.isMint().toBoolean()) {
        // mint
        if (currentIndex < NFT_SUPPLY) {
          currentIndex = currentIndex + 1n;
          //   let currentNftHash = currAction.nft
          //     .assignId(Field(currentIndex))
          //     .hash();
          let currentNft = currAction.nft.assignId(Field(currentIndex));

          let currentMerkleProof = await offchainStorage.prove(currentIndex);
          newMerkleProofs.push(currentMerkleProof);

          await offchainStorage.update(currentIndex, currentNft);
        } else {
          newMerkleProofs.push(dummyProof);
        }
      }

      if (currAction.isTransfer().toBoolean()) {
        let nftExist = false;
        let savedNft = await offchainStorage.get(currentNftIdBigInt);
        if (
          savedNft !== null &&
          savedNft.hash().equals(currAction.originalNFTHash)
        ) {
          nftExist = true;
        }

        if (nftExist) {
          console.log('nft exist, id: ', currentNftId.toString());
          let currentMerkleProof = await offchainStorage.prove(
            currentNftIdBigInt
          );
          newMerkleProofs.push(currentMerkleProof);

          await offchainStorage.update(currentNftIdBigInt, currAction.nft);
        } else {
          console.log('fake nft, id: ', currentNftId.toString());
          newMerkleProofs.push(dummyProof);
        }
      }
    }

    // pad action array
    let dummyAction = Action.empty();
    for (let i = actions.length; i < ActionBatch.batchSize; i++) {
      actions.push(dummyAction);
      newMerkleProofs.push(dummyProof);
    }

    let actionBatch = new ActionBatch({
      actions,
      merkleProofs: newMerkleProofs,
    });

    return {
      stateTransition: RollupStateTransition.from({
        source: currState,
        target: RollupState.from({
          nftsCommitment: offchainStorage.getRoot(),
          currentIndex: Field(currentIndex),
          currentActionsHash,
        }),
      }),
      actionBatch,
    };
  },

  merge(
    p1: SelfProof<RollupStateTransition>,
    p2: SelfProof<RollupStateTransition>
  ): RollupStateTransition {
    let source = p1.publicInput.source;
    let target = p2.publicInput.target;

    return RollupStateTransition.from({
      source,
      target,
    });
  },
};
