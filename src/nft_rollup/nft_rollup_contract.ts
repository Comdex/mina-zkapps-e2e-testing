import { MemoryStore, MerkleTree } from 'snarky-smt';
import {
  Circuit,
  CircuitString,
  DeployArgs,
  Field,
  method,
  Permissions,
  PublicKey,
  Reducer,
  SmartContract,
  state,
  State,
  UInt32,
  UInt64,
} from 'snarkyjs';
import { TokenContract } from '../token/token_contract';
import { TREE_HEIGHT, NFT_SUPPLY } from './constants';

import { NFT, Action, RollupState, SignatureWithSigner } from './model';
import { NftRollupProof } from './rollup_prover';

export { NftRollupContract, NFT_INIT_INDEX, NFT_INIT_ACTIONSHASH };

const NFT_NAME = 'MinaGenesis';
const NFT_SYMBOL = 'MG';
const NFT_INIT_COMMITMENT = (
  await MerkleTree.build(new MemoryStore<NFT>(), TREE_HEIGHT, NFT)
).getRoot();
const NFT_INIT_INDEX = Field(0);
const NFT_INIT_ACTIONSHASH = Reducer.initialActionsHash;

console.log('nft initCommitment: ', NFT_INIT_COMMITMENT.toString());

class NftRollupContract extends SmartContract {
  // constant supply
  SUPPLY = Field(NFT_SUPPLY);
  reducer = Reducer({ actionType: Action });

  @state(RollupState) state = State<RollupState>();
  @state(UInt32) mintStartBlockHeight = State<UInt32>();
  @state(PublicKey) tokenContractAddress = State<PublicKey>();

  deployNftRollupContract(
    args: DeployArgs,
    mintStartBlockHeight: UInt32,
    tokenContractAddress: PublicKey
  ) {
    super.deploy(args);

    this.state.set(
      new RollupState({
        nftsCommitment: NFT_INIT_COMMITMENT,
        currentIndex: NFT_INIT_INDEX,
        currentActionsHash: NFT_INIT_ACTIONSHASH,
      })
    );
    this.mintStartBlockHeight.set(mintStartBlockHeight);
    this.tokenContractAddress.set(tokenContractAddress);
    this.account.zkappUri.set(
      'https://github.com/Comdex/mina-zkapps-e2e-testing'
    );
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof(),
      editSequenceState: Permissions.proof(),
    });
  }

  name(): CircuitString {
    return CircuitString.fromString(NFT_NAME);
  }

  symbol(): CircuitString {
    return CircuitString.fromString(NFT_SYMBOL);
  }

  // Start minting a nft after the specified block height
  // Charge 5 custom tokens for each minting
  @method mint(nft: NFT) {
    nft.isAssignedId().assertFalse();

    // Check mint start block height
    const mintStartBlockHeight = this.mintStartBlockHeight.get();
    Circuit.log('mintStartBlockHeight: ', mintStartBlockHeight);
    this.mintStartBlockHeight.assertEquals(mintStartBlockHeight);

    // Minting is only allowed after the specified block height
    const currentBlockHeight = this.network.blockchainLength.get();
    Circuit.log('currentBlockHeight: ', currentBlockHeight);
    this.network.blockchainLength.assertBetween(
      currentBlockHeight,
      UInt32.MAXINT()
    );
    currentBlockHeight.assertGreaterThanOrEqual(
      mintStartBlockHeight,
      'Too early to mint'
    );

    // Use a custom token to pay fees, amount is 5
    let tokenContractAddress = this.tokenContractAddress.get();
    this.tokenContractAddress.assertEquals(tokenContractAddress);
    let tokenContract = new TokenContract(tokenContractAddress);
    tokenContract.transfer(nft.owner, this.address, UInt64.from(5));

    this.reducer.dispatch(Action.mint(nft));
  }

  // Transfer a nft to another account
  @method transfer(
    receiver: PublicKey,
    nft: NFT,
    ownerSign: SignatureWithSigner
  ) {
    nft.isAssignedId().assertTrue();
    nft.owner.assertEquals(ownerSign.signer);
    ownerSign.sign
      .verify(ownerSign.signer, receiver.toFields().concat(NFT.toFields(nft)))
      .assertTrue('Invalid signature');

    const originalNFTHash = nft.hash();
    let newNft = nft.changeOwner(receiver);

    this.reducer.dispatch(Action.transfer(newNft, originalNFTHash));
  }

  // Rollup nft txs and update contract state
  @method rollup(proof: NftRollupProof) {
    proof.verify();

    let state = this.state.get();
    this.state.assertEquals(state);

    this.account.sequenceState.assertEquals(
      proof.publicInput.target.currentActionsHash
    );
    proof.publicInput.source.assertEquals(state);
    this.state.set(proof.publicInput.target);
    Circuit.log('circuit-rollup success');
  }
}
