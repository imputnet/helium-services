//! derives each component's signing key, and so its app id, from one secret.

use crate::BoxError;
use aws_lc_rs::hmac;
use aws_lc_rs::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair};
use crx3::Signer as _;
use crx3::aws_lc::EcdsaSigner;
use omaha_protocol::AppId;
use sha2::Digest;

// a p-256 sec1 ECPrivateKey, around its 32 byte scalar
const SEC1_PREFIX: [u8; 7] = [0x30, 0x31, 0x02, 0x01, 0x01, 0x04, 0x20];
const SEC1_SUFFIX: [u8; 12] = [
    0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
];

/// Each component's signing key, derived from one secret by the component's
/// name, so every component has its own id without a key to keep for each.
pub struct Keys(hmac::Key);

impl Keys {
    pub fn new(secret: &[u8]) -> Self {
        Keys(hmac::Key::new(hmac::HMAC_SHA256, secret))
    }

    pub fn signer(&self, name: &str) -> Result<EcdsaSigner, BoxError> {
        for counter in 0..=u8::MAX {
            let mut context = hmac::Context::with_key(&self.0);
            context.update(b"helium component key\0");
            context.update(name.as_bytes());
            context.update(&[counter]);
            let scalar = context.sign();
            let der = [&SEC1_PREFIX[..], scalar.as_ref(), &SEC1_SUFFIX].concat();

            // a scalar outside the curve's order isn't a key, so try the next
            if let Ok(key) =
                EcdsaKeyPair::from_private_key_der(&ECDSA_P256_SHA256_ASN1_SIGNING, &der)
            {
                return Ok(EcdsaSigner::from_pkcs8(key.to_pkcs8v1()?.as_ref())?);
            }
        }

        Err(format!("no key for {name}").into())
    }

    /// SHA-256 of the public key, which Chromium's installer policy pins.
    pub fn hash(&self, name: &str) -> Result<[u8; 32], BoxError> {
        Ok(sha2::Sha256::digest(self.signer(name)?.public_key()).into())
    }

    pub fn appid(&self, name: &str) -> Result<AppId, BoxError> {
        let id = crx3::id_from_public_key(self.signer(name)?.public_key());
        AppId::new(&id).ok_or_else(|| format!("{name}: invalid id {id}").into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_one_key_per_name() {
        let keys = Keys::new(b"secret");
        let crlset = keys.appid("crlset").unwrap();
        assert_eq!(Keys::new(b"secret").appid("crlset").unwrap(), crlset);
        assert_ne!(keys.appid("translation-de-en").unwrap(), crlset);
        assert_ne!(Keys::new(b"other").appid("crlset").unwrap(), crlset);
        assert_eq!(
            crx3::id_from_public_key(keys.signer("crlset").unwrap().public_key()),
            crlset.as_str()
        );
    }
}
