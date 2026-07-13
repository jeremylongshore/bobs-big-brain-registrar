# SOPS Age Secrets Management

SOPS with age encrypts secrets at rest so the ciphertext can be committed to
git safely. Each value is sealed to one or more age public keys, and only a
holder of the matching private key can decrypt it, so the repository carries the
secret without ever exposing the plaintext.

The workflow decrypts in memory at process start rather than writing a
plaintext file to disk. Committing the encrypted file keeps a single source of
truth under version control while the private key stays out of the tree,
rotated independently of the code.
