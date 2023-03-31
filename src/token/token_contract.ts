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
    this.totalAmountInCirculation.set(UInt64.zero);
    this.account.zkappUri.set(
      'https://github.com/Comdex/mina-zkapps-e2e-testing'
    );

    if (initialFundParams !== undefined && initialFundParams.length > 0) {
      initialFundParams.forEach((initialFundParam) => {
        this.token.mint(initialFundParam);
        this.emitEvent(
          'mint',
          new TokenManageEvent({
            receiver: initialFundParam.address,
            amount: initialFundParam.amount,
          })
        );
      });
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

  @method updateDelegate(delegateAddress: PublicKey, adminSign: Signature) {
    adminSign.verify(this.address, delegateAddress.toFields()).assertTrue();
    this.account.delegate.set(delegateAddress);
  }
}
