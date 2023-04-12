import {
  AccountUpdate,
  Bool,
  Circuit,
  DeployArgs,
  method,
  Permissions,
  PublicKey,
  Signature,
  SmartContract,
  state,
  State,
  UInt32,
  UInt64,
} from 'snarkyjs';
import {
  TokenManageEvent,
  TokenTransferEvent,
  AdminPermit,
  AdminPermitWithSign,
} from './model';

export const TOKEN_SYMBOL = 'BASE';

export class TokenContract extends SmartContract {
  @state(UInt64) totalAmountInCirculation = State<UInt64>();

  events = {
    mint: TokenManageEvent,
    burn: TokenManageEvent,
    transfer: TokenTransferEvent,
  };

  deployToken(
    args: DeployArgs,
    ...initialFundParams: { address: PublicKey; amount: UInt64 }[]
  ) {
    super.deploy(args);
    this.account.tokenSymbol.set(TOKEN_SYMBOL);
    this.account.zkappUri.set(
      'https://github.com/Comdex/mina-zkapps-e2e-testing'
    );

    if (initialFundParams !== undefined && initialFundParams.length > 0) {
      let totalAmountInCirculation = UInt64.zero;
      initialFundParams.forEach((initialFundParam) => {
        this.token.mint(initialFundParam);
        totalAmountInCirculation = totalAmountInCirculation.add(
          initialFundParam.amount
        );
        this.emitEvent(
          'mint',
          new TokenManageEvent({
            receiver: initialFundParam.address,
            amount: initialFundParam.amount,
          })
        );
      });
      this.totalAmountInCirculation.set(totalAmountInCirculation);
    } else {
      this.totalAmountInCirculation.set(UInt64.zero);
    }
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof(),
      setTokenSymbol: Permissions.proofOrSignature(),
      incrementNonce: Permissions.proof(),
      setTiming: Permissions.proof(),
      setDelegate: Permissions.proof(),
    });
  }

  // Minting tokens with admin authorization.
  @method mint(permitWithsign: AdminPermitWithSign) {
    Circuit.log('mint amount: ', permitWithsign.permit.amount);
    let totalAmountInCirculation = this.totalAmountInCirculation.get();
    this.totalAmountInCirculation.assertEquals(totalAmountInCirculation);

    let newTotalAmountInCirculation = totalAmountInCirculation.add(
      permitWithsign.permit.amount
    );

    // Using nonce to prevent signature replay attacks
    this.account.nonce.assertEquals(permitWithsign.permit.adminNonce);
    this.self.body.incrementNonce = Bool(true);
    permitWithsign.adminSign
      .verify(this.address, AdminPermit.toFields(permitWithsign.permit))
      .assertTrue();

    this.token.mint({
      address: permitWithsign.permit.receiver,
      amount: permitWithsign.permit.amount,
    });

    this.totalAmountInCirculation.set(newTotalAmountInCirculation);
    this.emitEvent(
      'mint',
      new TokenManageEvent({
        receiver: permitWithsign.permit.receiver,
        amount: permitWithsign.permit.amount,
      })
    );
  }

  // Burn tokens
  @method burn(receiverAddress: PublicKey, amount: UInt64) {
    Circuit.log('burn amount: ', amount);
    let totalAmountInCirculation = this.totalAmountInCirculation.get();
    this.totalAmountInCirculation.assertEquals(totalAmountInCirculation);
    let newTotalAmountInCirculation = totalAmountInCirculation.sub(amount);

    this.token.burn({
      address: receiverAddress,
      amount,
    });

    this.totalAmountInCirculation.set(newTotalAmountInCirculation);

    this.emitEvent(
      'burn',
      new TokenManageEvent({
        receiver: receiverAddress,
        amount,
      })
    );
  }

  // Transfer tokens
  @method transfer(
    senderAddress: PublicKey,
    receiverAddress: PublicKey,
    amount: UInt64
  ) {
    Circuit.log('transfer amount: ', amount);
    this.token.send({
      from: senderAddress,
      to: receiverAddress,
      amount,
    });

    this.emitEvent(
      'transfer',
      new TokenTransferEvent({
        sender: senderAddress,
        receiver: receiverAddress,
        amount,
      })
    );
  }

  // Exchange tokens for mina
  // The payer pays mina, and the receiver receives a quantity of BASE token equal to tokenAmount.
  // 1 BASE = 0.01 MINA
  @method exchangeTokensByMina(
    payer: PublicKey,
    receiver: PublicKey,
    tokenAmount: UInt64
  ) {
    Circuit.log('exchange tokenAmount: ', tokenAmount);
    // Each token requires 0.01 mina to exchange
    let minaToSpend = tokenAmount.mul(UInt64.from(0.01 * 1e9));
    let accountUpdate = AccountUpdate.createSigned(payer);
    accountUpdate.balance.subInPlace(minaToSpend);
    this.balance.addInPlace(minaToSpend);

    let totalAmountInCirculation = this.totalAmountInCirculation.get();
    this.totalAmountInCirculation.assertEquals(totalAmountInCirculation);
    let newTotalAmountInCirculation = totalAmountInCirculation.add(tokenAmount);

    this.token.mint({ address: receiver, amount: tokenAmount });
    this.totalAmountInCirculation.set(newTotalAmountInCirculation);
  }

  // Locking mina within thecontract at a specified release time.
  @method setTimeLockedVault(
    amountToLock: UInt64,
    cliffTime: UInt32,
    adminSign: Signature
  ) {
    adminSign
      .verify(
        this.address,
        amountToLock.toFields().concat(cliffTime.toFields())
      )
      .assertTrue('Invalid admin signature');

    this.account.timing.set({
      initialMinimumBalance: amountToLock,
      cliffTime,
      cliffAmount: amountToLock,
      vestingPeriod: UInt32.from(1), // default value
      vestingIncrement: UInt64.from(0),
    });
  }

  // Update the delegate of the contract by admin's signature
  @method updateDelegate(delegateAddress: PublicKey, adminSign: Signature) {
    adminSign.verify(this.address, delegateAddress.toFields()).assertTrue();
    this.account.delegate.set(delegateAddress);
  }
}
