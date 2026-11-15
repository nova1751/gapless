# CryptoJS core / MD5

Pinned dependency: crypto-js 4.2.0, npm tarball `crypto-js-4.2.0.tgz`.
Upstream: https://github.com/brix/crypto-js/tree/4.2.0
Only unmodified core.js and md5.js are vendored. MIT license: LICENSE.
Used for integrity checking of original NetEase cache bytes, not password/security hashing.
No runtime dependency download. Both packaging scripts embed these modules only in the optional dedicated cache Worker source.
