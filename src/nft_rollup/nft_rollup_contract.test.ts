import { MemoryStore, MerkleTree } from 'snarky-smt';
import {
  AccountUpdate,
  Field,
  isReady,
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
import { fetchActions } from 'snarkyjs/dist/node/lib/fetch';
import { TokenContract } from '../token/token_contract';

describe('NftRollupContract e2e testing', () => {
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

  async function fetchAllAccounts(): Promise<void> {
    console.log('fetching all accounts...');
    await ctx.getAccount(tokenContractAddress);
    await ctx.getAccount(nftContractAddress);
    await ctx.getAccount(callerAAddress, tokenId);
    await ctx.getAccount(callerBAddress, tokenId);
    await ctx.getAccount(callerCAddress, tokenId);
  }

  async function deployTokenAndNftContract(): Promise<UInt32> {
    console.log('deploying token contract and nft rollup contract...');
    let currentBlockHeight = (await ctx.getNetworkStatus())
      .blockchainLength as UInt32;

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
    await isReady;

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

    await ctx.initMinaNetwork();
    await setupAccounts();
  }, TEST_TIMEOUT);

  afterAll(() => {
    setInterval(shutdown, 0);
  });

  it(
    `NftRollup basic functional testing - deployToBerkeley: ${ctx.deployToBerkeley}, proofsEnabled: ${ctx.proofsEnabled}`,
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
      expect(nftContractAccount.permissions.editSequenceState).toEqual(
        Permissions.proof()
      );

      // check token contract accounts exists in the ledger
      let callerAAccount = await ctx.getAccount(callerAAddress, tokenId);
      expect(callerAAccount.balance.toBigInt()).toEqual(initialFundTokenAmount);
      let callerBAccount = await ctx.getAccount(callerBAddress, tokenId);
      expect(callerBAccount.balance.toBigInt()).toEqual(initialFundTokenAmount);
      let callerCAccount = await ctx.getAccount(callerCAddress, tokenId);
      expect(callerCAccount.balance.toBigInt()).toEqual(3n);

      //-----------------mint nft------------------
      // Minting should fail if the current block height is less than mintStartBlockHeight
      await ctx.getNetworkStatus();
      await fetchAllAccounts();
      let mintErr;
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
        mintErr = err;
      }
      expect(mintErr).toBeDefined();

      // Minting should fail if the caller does not have enough token balance, balance: 3 < fee: 5
      await ctx.getNetworkStatus();
      await fetchAllAccounts();
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
        mintErr = err;
      }
      expect(mintErr).toBeDefined();

      // Minting should succeed if the current block height is greater than or equal to mintStartBlockHeight
      // wait for the block height to be greater than or equal to mintStartBlockHeight
      await ctx.waitForBlock(currentMintStartBlockHeight);

      console.log('start mint nfts...');
      let nftContractTokenBalance = initialFundTokenAmount;
      await ctx.getNetworkStatus();
      await fetchAllAccounts();
      let tx2 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Mint nfts batch 1',
        },
        () => {
          // The current NFT contract address does not have a token account, so a creation fee needs to be paid
          // AccountUpdate.fundNewAccount(feePayerAddress, 1);
          nftContract.mint(NFT.createNFT('Mina Test NFT 1', callerAAddress));
          nftContract.mint(NFT.createNFT('Mina Test NFT 2', callerAAddress));
        }
      );
      await ctx.submitTx(tx2, {
        feePayerKey,
        contractKeys: [nftContractKey],
        otherSignKeys: [callerAKey],
        logLabel: 'mint nfts batch 1',
      });

      nftContractTokenBalance = nftContractTokenBalance + 10n;
      let nftContractTokenAccount = await ctx.getAccount(
        nftContractAddress,
        tokenId
      );
      expect(nftContractTokenAccount.balance.toBigInt()).toEqual(
        nftContractTokenBalance
      );

      // Mint nft batch 2
      await ctx.getNetworkStatus();
      await fetchAllAccounts();
      let tx3 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Minting nfts batch 2',
        },
        () => {
          nftContract.mint(NFT.createNFT('Mina Test NFT 3', callerAAddress));
          nftContract.mint(NFT.createNFT('Mina Test NFT 4', callerAAddress));
        }
      );
      await ctx.submitTx(tx3, {
        feePayerKey,
        contractKeys: [nftContractKey],
        otherSignKeys: [callerAKey],
        logLabel: 'mint nfts batch 2',
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
      let mergedProof = await runRollupBatchProve(
        nftContract,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
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

      await ctx.getAccount(nftContractAddress);
      let currState = nftContract.state.get();
      expect(currState).toEqual(mergedProof?.publicInput.target);

      //-----------------transfer nft------------------
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
          memo: 'Transfer nfts batch',
        },
        () => {
          nftContract.transfer(callerBAddress, nft1!, sign1);
          nftContract.transfer(callerBAddress, nft2!, sign2);
        }
      );
      await ctx.submitTx(tx5, {
        feePayerKey,
        contractKeys: [nftContractKey],
        logLabel: 'transfer nfts batch',
      });

      if (ctx.deployToBerkeley) {
        await fetchActions({
          publicKey: nftContractAddress.toBase58(),
        });
      }
      let actions = nftContract.reducer.getActions({
        fromActionHash: Reducer.initialActionsHash,
      });
      expect(actions.length).toEqual(6);

      // Test transfer transaction and mint transaction mixed rollup
      await ctx.getNetworkStatus();
      await fetchAllAccounts();
      let mintNft = NFT.createNFT('Mina Test NFT 5', callerBAddress);
      let tx6 = await Mina.transaction(
        {
          sender: feePayerAddress,
          fee: ctx.txFee,
          memo: 'Minting nft',
        },
        () => {
          nftContract.mint(mintNft);
        }
      );
      await ctx.submitTx(tx6, {
        feePayerKey,
        contractKeys: [nftContractKey],
        otherSignKeys: [callerBKey],
        logLabel: 'mint nft',
      });

      if (ctx.deployToBerkeley) {
        await fetchActions({ publicKey: nftContractAddress.toBase58() });
      }
      let actions4 = nftContract.reducer.getActions({
        fromActionHash: Reducer.initialActionsHash,
      });
      expect(actions4.length).toEqual(7);
      // Check the correctness of the action
      expect(actions4[6][0]).toEqual(Action.mint(mintNft));

      //-----------------rollup transfer and mint txs------------------
      let mergedProof2 = await runRollupBatchProve(
        nftContract,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        offchainStorage,
        ctx.deployToBerkeley
      );
      await ctx.getAccount(nftContractAddress);
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

      await ctx.getAccount(nftContractAddress);
      let currState2 = nftContract.state.get();
      expect(currState2).toEqual(mergedProof2?.publicInput.target);
    },
    TEST_TIMEOUT
  );
});
