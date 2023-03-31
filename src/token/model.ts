import {
  Struct,
  PublicKey,
  UInt64,
  Signature,
  PrivateKey,
  isReady,
  UInt32,
} from 'snarkyjs';

export {
  TokenTransferEvent,
  TokenManageEvent,
  AdminPermit,
  AdminPermitWithSign,
};

await isReady;

class TokenTransferEvent extends Struct({
  sender: PublicKey,
  receiver: PublicKey,
  amount: UInt64,
}) {}

class TokenManageEvent extends Struct({
  receiver: PublicKey,
  amount: UInt64,
}) {}

class AdminPermit extends Struct({
  receiver: PublicKey,
  amount: UInt64,
  adminNonce: UInt32,
}) {}

class AdminPermitWithSign extends Struct({
  permit: AdminPermit,
  adminSign: Signature,
}) {
  static create(value: {
    receiver: PublicKey;
    amount: UInt64;
    adminNonce: UInt32;
    adminKey: PrivateKey;
  }): AdminPermitWithSign {
    let permit = new AdminPermit({
      receiver: value.receiver,
      amount: value.amount,
      adminNonce: value.adminNonce,
    });
    return new AdminPermitWithSign({
      permit,
      adminSign: Signature.create(value.adminKey, AdminPermit.toFields(permit)),
    });
  }
}
