/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { MemoryStore, MerkleTree } from 'snarky-smt';
import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  Reducer,
  shutdown,
  UInt32,
  UInt64,
  Permissions,
} from 'snarkyjs';
import { TREE_HEIGHT } from './constants';
import { getTestContext, MINA, TEST_TIMEOUT } from '../test_utils';
import { Action, NFT, SignatureWithSigner } from './model';
import { NftRollupContract } from './nft_rollup_contract';
import { runRollupBatchProve } from './run_prover';
import { NftRollupProver } from './rollup_prover';
import { TokenContract } from '../token/token_contract';

describe('NftRollupContract E2E testing', () => {
  let feePayerKey: PrivateKey;
  let feePayerAddress: PublicKey;
  let callerAKey: PrivateKey;
  let callerAAddress: PublicKey;
  let callerBKey: PrivateKey;
  let callerBAddress: PublicKey;
  let callerCKey: PrivateKey;
  let callerCAddress: PublicKey;

  let nftContractKey: PrivateKey;
  let nftContractAddress: PublicKey;
  let nftContract: NftRollupContract;

  let tokenContractKey: PrivateKey;
  let tokenContractAddress: PublicKey;
  let tokenContract: TokenContract;
  let tokenId: Field;

  let initialFundTokenAmount: bigint;

  const ctx = getTestContext(true);

  async function setupAccounts() {
    feePayerKey = await ctx.getFundedAccountForTest(BigInt(7 * MINA), 'nft');
    feePayerAddress = feePayerKey.toPublicKey();
    nftContractKey = PrivateKey.random();
    nftContractAddress = nftContractKey.toPublicKey();
    callerAKey = PrivateKey.random();
    callerAAddress = callerAKey.toPublicKey();
    callerBKey = PrivateKey.random();
    callerBAddress = callerBKey.toPublicKey();
    callerCKey = PrivateKey.random();
    callerCAddress = callerCKey.toPublicKey();

    nftContract = new NftRollupContract(nftContractAddress);

    tokenContractKey = PrivateKey.random();
    tokenContractAddress = tokenContractKey.toPublicKey();
    tokenContract = new TokenContract(tokenContractAddress);
    tokenId = tokenContract.token.id;
    console.log('use tokenId: ', tokenId.toString());

    initialFundTokenAmount = 300n;
    console.log('iinitialFundTokenAmount: ', initialFundTokenAmount);

    console.log(`Use the following addresses to test:
  feePayer: ${feePayerAddress.toBase58()}
  token contract: ${tokenContractAddress.toBase58()}
  nft rollup contract: ${nftContractKey.toPublicKey().toBase58()}
  callerA: ${callerAAddress.toBase58()}
  callerB: ${callerBAddress.toBase58()}`);
  }

  async function deployTokenAndNftContract(): Promise<UInt32> {
    console.log('deploying token contract and nft rollup contract...');
    let currentBlockHeight = (await ctx.getNetworkStatus()).blockchainLength;

    let mintStartBlockHeight = currentBlockHeight.add(3);
    let tx = await Mina.transaction(
      {
        sender: feePayerAddress,
        fee: ctx.txFee,
        memo: 'Deploying contracts',
      },
      () => {
        AccountUpdate.fundNewAccount(feePayerAddress, 6);
        tokenContract.deployToken(
          { zkappKey: tokenContractKey },
          {
            address: nftContractAddress,
            amount: UInt64.from(initialFundTokenAmount),
          },
          {
            address: callerAAddress,
            amount: UInt64.from(initialFundTokenAmount),
          },
          {
            address: callerBAddress,
            amount: UInt64.from(initialFundTokenAmount),
          },
          { address: callerCAddress, amount: UInt64.from(3n) }
        );

        nftContract.deployNftRollupContract(
          { zkappKey: nftContractKey },
          mintStartBlockHeight,
          tokenContractAddress
        );
      }
    );

    await ctx.submitTx(tx, {
      feePayerKey,
      contractKeys: [tokenContractKey, nftContractKey],
      logLabel: 'deploy token contract and nft rollup contract',
    });
    return mintStartBlockHeight;
  }

  beforeAll(async () => {
    await ctx.initMinaNetwork();
    await setupAccounts();

    console.log('start compiling TokenpContract...');
    console.time('TokenContract compile');
    let tokenVerificationKey = (await TokenContract.compile()).verificationKey;
    console.timeEnd('TokenContract compile');
    console.log(
      'TokenContract VerificationKey: ',
      JSON.stringify(tokenVerificationKey)
    );

    console.log('start compiling NftRollupProver...');
    console.time('NftRollupProver compile');
    await NftRollupProver.compile();
    console.timeEnd('NftRollupProver compile');

    console.log('start compiling NftRollupContract...');
    console.time('NftRollupContract compile');
    let nftVerificationKey = (await NftRollupContract.compile())
      .verificationKey;
    console.timeEnd('NftRollupContract compile');
    console.log(
      'NftRollupContract VerificationKey: ',
      JSON.stringify(nftVerificationKey)
    );
  }, TEST_TIMEOUT);

  afterAll(() => {
    setInterval(shutdown, 0);
  });

  it(
    `NFT mint, transfer and rollup testing - deployToBerkeley: ${ctx.deployToBerkeley}`,
    async () => {
      //------------deploy contract----------------
      let mintBlock = await deployTokenAndNftContract();
      console.log('nft start mint block height: ', mintBlock.toString());

      // init offchainStorage
      let offchainStorage: MerkleTree<NFT> = await MerkleTree.build<NFT>(
        new MemoryStore<NFT>(),
        TREE_HEIGHT,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignores
        NFT
      );

      // Check contract accounts exists in the ledger
      let tokenContractAccount = await ctx.getAccount(tokenContractAddress);
      expect(tokenContractAccount).toBeDefined();

      let nftContractAccount = await ctx.getAccount(nftContractAddress);
      expect(nftContractAccount).toBeDefined();
      const currentMintStartBlockHeight =
        nftContract.mintStartBlockHeight.get();
      expect(mintBlock).toEqual(currentMintStartBlockHeight);
      const tokenAddress = nftContract.tokenContractAddress.get();
      expect(tokenAddress).toEqual(tokenContractAddress);
      expect(nftContractAccount.zkapp?.zkappUri).toEqual(
        'https://github.com/Comdex/mina-zkapps-e2e-testing'
      );
      expect(nftContractAccount.permissions.editState).toEqual(
        Permissions.proof()
      );
      expect(nftContractAccount.permissions.editActionState).toEqual(
        Permissions.proof()
      );

      // check token contract accounts exists in the ledger
      let callerAAccount = await ctx.getAccount(callerAAddress, tokenId);
      expect(callerAAccount.balance.toBigInt()).toEqual(initialFundTokenAmount);
      let callerBAccount = await ctx.getAccount(callerBAddress, tokenId);
      expect(callerBAccount.balance.toBigInt()).toEqual(initialFundTokenAmount);
      let callerCAccount = await ctx.getAccount(callerCAddress, tokenId);
      expect(callerCAccount.balance.toBigInt()).toEqual(3n);

      let nftContractTokenBalance = initialFundTokenAmount;

      //-----------------mint nft------------------
      // Minting should fail if the current block height is less than mintStartBlockHeight
      try {
        let tx = await Mina.transaction(
          {
            sender: feePayerAddress,
            fee: ctx.txFee,
            memo: 'Mint nft',
          },
          () => {
            nftContract.mint(NFT.createNFT('Mina Test NFT A', callerAAddress));
          }
        );
        await ctx.submitTx(tx, {
          feePayerKey,
          contractKeys: [nftContractKey],
          otherSignKeys: [callerAKey],
          logLabel: 'mint nft',
        });
      } catch (err) {
        console.log('As Expected, minting should fail: ', err);
      }
      let nftContractTokenAccount = await ctx.getAccount(
        nftContractAddress,
        tokenId
      );
      expect(nftContractTokenAccount.balance.toBigInt()).toEqual(
        nftContractTokenBalance
      );

      // Minting should fail if the caller does not have enough token balance, balance: 3 < fee: 5
      try {
        let tx = await Mina.transaction(
          {
            sender: feePayerAddress,
            fee: ctx.txFee,
            memo: 'Mint nft',
          },
          () => {
            nftContract.mint(NFT.createNFT('Mina Test NFT C', callerCAddress));
          }
        );
        await ctx.submitTx(tx, {
          feePayerKey,
          contractKeys: [nftContractKey],
          otherSignKeys: [callerCKey],
          logLabel: 'mint nft',
        });
      } catch (err) {
        console.log('As Expected, minting should fail: ', err);
      }
      nftContractTokenAccount = await ctx.getAccount(
        nftContractAddress,
        tokenId
      );
      expect(nftContractTokenAccount.balance.toBigInt()).toEqual(
        nftContractTokenBalance
      );

      // Minting should succeed if the current block height is greater than or equal to mintStartBlockHeight
      // wait for the block height to be greater than or equal to mintStartBlockHeight
      await ctx.waitForBlock(currentMintStartBlockHeight);

      console.log('start mint nfts...');
      // mint nft 1
      let tx2 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Mint nft 1',
        },
        () => {
          nftContract.mint(NFT.createNFT('Mina Test NFT 1', callerAAddress));
        }
      );
      await ctx.submitTx(tx2, {
        feePayerKey,
        contractKeys: [nftContractKey],
        otherSignKeys: [callerAKey],
        logLabel: 'mint nft 1',
      });
      // mint nft 2
      tx2 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Mint nft 2',
        },
        () => {
          nftContract.mint(NFT.createNFT('Mina Test NFT 2', callerAAddress));
        }
      );
      await ctx.submitTx(tx2, {
        feePayerKey,
        contractKeys: [nftContractKey],
        otherSignKeys: [callerAKey],
        logLabel: 'mint nft 2',
      });

      nftContractTokenBalance = nftContractTokenBalance + 10n;
      nftContractTokenAccount = await ctx.getAccount(
        nftContractAddress,
        tokenId
      );
      expect(nftContractTokenAccount.balance.toBigInt()).toEqual(
        nftContractTokenBalance
      );

      // mint nft 3
      let tx3 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Mint nft 3',
        },
        () => {
          nftContract.mint(NFT.createNFT('Mina Test NFT 3', callerAAddress));
        }
      );
      await ctx.submitTx(tx3, {
        feePayerKey,
        contractKeys: [nftContractKey],
        otherSignKeys: [callerAKey],
        logLabel: 'mint nft 3',
      });
      // Mint nft 4
      tx3 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Mint nft 4',
        },
        () => {
          nftContract.mint(NFT.createNFT('Mina Test NFT 4', callerAAddress));
        }
      );
      await ctx.submitTx(tx3, {
        feePayerKey,
        contractKeys: [nftContractKey],
        otherSignKeys: [callerAKey],
        logLabel: 'mint nft 4',
      });

      nftContractTokenBalance = nftContractTokenBalance + 10n;
      nftContractTokenAccount = await ctx.getAccount(
        nftContractAddress,
        tokenId
      );
      expect(nftContractTokenAccount.balance.toBigInt()).toEqual(
        nftContractTokenBalance
      );

      //-----------------rollup mint txs------------------
      console.log('start rollup mint txs...');
      await ctx.waitForBlock();
      await ctx.waitForBlock();
      let mergedProof = await runRollupBatchProve(
        nftContract,
        offchainStorage,
        ctx.deployToBerkeley
      );
      await ctx.getAccount(nftContractAddress);
      let tx4 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'rollup mint txs',
        },
        () => {
          nftContract.rollup(mergedProof!);
        }
      );
      await ctx.submitTx(tx4, {
        feePayerKey,
        contractKeys: [nftContractKey],
        logLabel: 'rollup mint txs',
      });

      if (ctx.deployToBerkeley) {
        await ctx.getAccount(nftContractAddress);
      }
      let currState = nftContract.state.get();
      expect(currState).toEqual(mergedProof?.publicInput.target);

      //-----------------transfer nft------------------
      console.log('start transfer nfts...');
      let nft1 = await offchainStorage.get(1n);
      let sign1 = SignatureWithSigner.create(
        callerAKey,
        callerBAddress.toFields().concat(NFT.toFields(nft1!))
      );
      let nft2 = await offchainStorage.get(2n);
      let sign2 = SignatureWithSigner.create(
        callerAKey,
        callerBAddress.toFields().concat(NFT.toFields(nft2!))
      );

      let tx5 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Transfer nft 1',
        },
        () => {
          nftContract.transfer(callerBAddress, nft1!, sign1);
        }
      );
      await ctx.submitTx(tx5, {
        feePayerKey,
        contractKeys: [nftContractKey],
        logLabel: 'transfer nft 1',
      });

      tx5 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Transfer nft 2',
        },
        () => {
          nftContract.transfer(callerBAddress, nft2!, sign2);
        }
      );
      await ctx.submitTx(tx5, {
        feePayerKey,
        contractKeys: [nftContractKey],
        logLabel: 'transfer nft 2',
      });

      // In order to ensure that the latest actions can be obtained, try to wait for 2 blocks
      await ctx.waitForBlock();
      await ctx.waitForBlock();
      let actions = await nftContract.reducer.fetchActions({
        fromActionState: Reducer.initialActionsHash,
      });
      expect(actions.length).toEqual(6);
      // Check the correctness of the transfer actions
      const originalNFTHash1 = nft1?.hash();
      const newNft1 = nft1?.changeOwner(callerBAddress);
      const transferAction1 = Action.transfer(newNft1!, originalNFTHash1!);
      expect(actions[4][0]).toEqual(transferAction1);

      const originalNFTHash2 = nft2?.hash();
      const newNft2 = nft2?.changeOwner(callerBAddress);
      const transferAction2 = Action.transfer(newNft2!, originalNFTHash2!);
      expect(actions[5][0]).toEqual(transferAction2);

      // Test transfer transaction and mint transaction mixed rollup
      let mintNft = NFT.createNFT('Mina Test NFT 5', callerBAddress);
      let tx6 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Mint nft 5',
        },
        () => {
          nftContract.mint(mintNft);
        }
      );
      await ctx.submitTx(tx6, {
        feePayerKey,
        contractKeys: [nftContractKey],
        otherSignKeys: [callerBKey],
        logLabel: 'mint nft 5',
      });

      await ctx.waitForBlock();
      await ctx.waitForBlock();
      let actions4 = await nftContract.reducer.fetchActions({
        fromActionState: Reducer.initialActionsHash,
      });
      expect(actions4.length).toEqual(7);
      // Check the correctness of the mint action
      expect(actions4[6][0]).toEqual(Action.mint(mintNft));

      //-----------------rollup transfer and mint txs------------------
      console.log('start rollup transfer and mint txs...');
      await ctx.waitForBlock();
      await ctx.waitForBlock();
      let mergedProof2 = await runRollupBatchProve(
        nftContract,
        offchainStorage,
        ctx.deployToBerkeley
      );
      let tx7 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'rollup transfer mint txs',
        },
        () => {
          nftContract.rollup(mergedProof2!);
        }
      );
      await ctx.submitTx(tx7, {
        feePayerKey,
        contractKeys: [nftContractKey],
        logLabel: 'rollup transfer and mint txs',
      });

      if (ctx.deployToBerkeley) {
        await ctx.getAccount(nftContractAddress);
      }
      let currState2 = nftContract.state.get();
      expect(currState2).toEqual(mergedProof2?.publicInput.target);
    },
    TEST_TIMEOUT
  );
});
