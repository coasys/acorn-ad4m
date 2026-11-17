# vendored acorn.happ

Copied from `/home/data/code/acorn-spike/acorn/happs/happ/workdir/acorn.happ`
(the Acorn `main-0.7` @ `90dc5995` projects hApp rebuilt against Holochain
0.7.0 guest crates in step 0).

- sha256: `86c3b516cbd98f502d58346d239e89da1ae58d255121b1c35cb8b4fec0d8cf9e`
- bundled DNA `projects.dna`, unseeded DNA hash (hc dna hash):
  `uhC0kfFXHbc-Q6C8iUT-p52GASyP3lsdVKSi7ip_IfjsFaoOuOSdl`
- hApp manifest keeps `provisioning: {strategy: create, deferred: true}`
  (deferred genesis; a provisioned cell is created at install and runs
  `init` lazily on the first zome call — verified in step 0)

0.7.0 rebuild from step 0; NOT the release DNA; different network than real
Acorn users until H1 (overview, Correction 1).
