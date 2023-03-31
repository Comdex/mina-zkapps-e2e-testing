import { createEmptyValue, ProvableMerkleTreeUtils } from 'snarky-smt';
import {
  Bool,
  Circuit,
  Encoding,
  Field,
  Poseidon,
  PrivateKey,
  PublicKey,
  Signature,
  Struct,
} from 'snarkyjs';
import { TREE_HEIGHT, ACTION_BATCH_SIZE } from './constants';

export {
  NFT,
  DUMMY_NFT_ID,
  DUMMY_NFT_HASH,
  RollupState,
  RollupStateTransition,
  ACTION_TYPE_MINT,
  ACTION_TYPE_TRANSFER,
  Action,
  MerkleProof,
  ActionBatch,
  SignatureWithSigner,
};

const ACTION_TYPE_DUMMY = Field(0);
const ACTION_TYPE_MINT = Field(1);
const ACTION_TYPE_TRANSFER = Field(2);
const DUMMY_ORIGINALNFTHASH = ProvableMerkleTreeUtils.EMPTY_VALUE;

const DUMMY_NFT_ID = Field(0);
const DUMMY_NFT_HASH = ProvableMerkleTreeUtils.EMPTY_VALUE;
const NFT_MAX_CONTENT_LENGTH = 2;

class NFT extends Struct({
  id: Field,
  owner: PublicKey,
  data: Circuit.array(Field, NFT_MAX_CONTENT_LENGTH),
}) {
  static createNFT(str: string, owner: PublicKey): NFT {
    let fs = Encoding.Bijective.Fp.fromString(str);
    if (fs.length > NFT_MAX_CONTENT_LENGTH) {
      throw new Error(
        `NFT content too long: ${fs.length} > NFT_MAX_CONTENT_LENGTH:${NFT_MAX_CONTENT_LENGTH}`
      );
    }
    let padFs = fs.concat(
      Array(NFT_MAX_CONTENT_LENGTH - fs.length).fill(Field(0))
    );
    return new NFT({ id: DUMMY_NFT_ID, owner, data: padFs });
  }

  changeOwner(newOwner: PublicKey): NFT {
    let newNFT = this.clone();
    newNFT.owner = newOwner;
    return newNFT;
  }

  assignId(id: Field): NFT {
    let newNFT = this.clone();
    newNFT.id = id;
    return newNFT;
  }

  isAssignedId(): Bool {
    return this.id.equals(DUMMY_NFT_ID).not();
  }

  clone(): NFT {
    return new NFT({
      id: this.id,
      owner: this.owner,
      data: this.data.slice(),
    });
  }

  hash(): Field {
    return Poseidon.hash(NFT.toFields(this));
  }

  getNFTString(): string {
    return Encoding.Bijective.Fp.toString(this.data);
  }

  toPretty(): any {
    return {
      id: this.id.toString(),
      owner: this.owner.toBase58(),
      data: this.getNFTString(),
    };
  }

  static empty(): NFT {
    return createEmptyValue(NFT) as NFT;
  }
}

class RollupState extends Struct({
  nftsCommitment: Field,
  currentIndex: Field,
  currentActionsHash: Field,
}) {
  static from(state: {
    nftsCommitment: Field;
    currentIndex: Field;
    currentActionsHash: Field;
  }) {
    return new this({
      nftsCommitment: state.nftsCommitment,
      currentIndex: state.currentIndex,
      currentActionsHash: state.currentActionsHash,
    });
  }

  assertEquals(other: RollupState) {
    Circuit.assertEqual(RollupState, this, other);
  }

  hash(): Field {
    return Poseidon.hash(RollupState.toFields(this));
  }

  toPretty(): any {
    return {
      nftsCommitment: this.nftsCommitment.toString(),
      currentIndex: this.currentIndex.toString(),
      currentActionsHash: this.currentActionsHash.toString(),
    };
  }
}

class RollupStateTransition extends Struct({
  source: RollupState,
  target: RollupState,
}) {
  static from(stateTransition: {
    source: RollupState;
    target: RollupState;
  }): RollupStateTransition {
    return new this({
      source: stateTransition.source,
      target: stateTransition.target,
    });
  }

  hash(): Field {
    return Poseidon.hash(RollupStateTransition.toFields(this));
  }

  toPretty(): any {
    return {
      source: this.source.toPretty(),
      target: this.target.toPretty(),
    };
  }
}

class Action extends Struct({ type: Field, originalNFTHash: Field, nft: NFT }) {
  isMint(): Bool {
    return this.type.equals(ACTION_TYPE_MINT);
  }

  isTransfer(): Bool {
    return this.type.equals(ACTION_TYPE_TRANSFER);
  }

  isDummyData(): Bool {
    return this.type.equals(ACTION_TYPE_DUMMY);
  }

  toPretty(): any {
    return {
      type: this.type.toString(),
      nft: this.nft.toPretty(),
      originalNFTHash: this.originalNFTHash.toString(),
    };
  }

  toFields(): Field[] {
    return Action.toFields(this);
  }

  toString(): string {
    return JSON.stringify(this.toPretty());
  }

  static empty(): Action {
    return createEmptyValue(Action) as Action;
  }

  static mint(nft: NFT): Action {
    return new Action({
      type: ACTION_TYPE_MINT,
      originalNFTHash: DUMMY_ORIGINALNFTHASH,
      nft,
    });
  }

  static transfer(nft: NFT, originalNFTHash: Field): Action {
    return new Action({ type: ACTION_TYPE_TRANSFER, originalNFTHash, nft });
  }
}

class MerkleProof extends ProvableMerkleTreeUtils.MerkleProof(TREE_HEIGHT) {}

class ActionBatch extends Struct({
  actions: Circuit.array(Action, ACTION_BATCH_SIZE),
  merkleProofs: Circuit.array(MerkleProof, ACTION_BATCH_SIZE),
}) {
  static batchSize = ACTION_BATCH_SIZE;
}

class SignatureWithSigner extends Struct({
  sign: Signature,
  signer: PublicKey,
}) {
  static create(signerKey: PrivateKey, message: Field[]): SignatureWithSigner {
    return new SignatureWithSigner({
      sign: Signature.create(signerKey, message),
      signer: signerKey.toPublicKey(),
    });
  }
}
