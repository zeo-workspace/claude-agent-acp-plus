# Changelog

## [0.23.5](https://github.com/zeo-workspace/claude-agent-acp-plus/compare/v0.23.4...v0.23.5) (2026-10-04)


### Bug Fixes

* **resume:** reopen a thread in the permission mode it was left in ([0f3385d](https://github.com/zeo-workspace/claude-agent-acp-plus/commit/0f3385d72134a1a88126314d8d10f04877402753))

## [0.23.4](https://github.com/zeo-workspace/claude-agent-acp-plus/compare/v0.23.3...v0.23.4) (2026-10-04)


### Bug Fixes

* **cancel:** end a cancelled turn when the force-cancel fires during an update ([47dd074](https://github.com/zeo-workspace/claude-agent-acp-plus/commit/47dd074e6254c9d339682a1ba971157eb5deb906))
* **close:** answer session/close without waiting for the interrupt reply ([b40b98d](https://github.com/zeo-workspace/claude-agent-acp-plus/commit/b40b98d97464fcd330efb29af9592170a5de5ec7))

## [0.23.3](https://github.com/zeo-workspace/claude-agent-acp-plus/compare/v0.23.2...v0.23.3) (2026-10-04)


### Bug Fixes

* **replay:** stop replaying other agents' messages and task notifications as prompts ([46f1b16](https://github.com/zeo-workspace/claude-agent-acp-plus/commit/46f1b16194c39d0f154d07c30b4c3052c1ea866c))

## [0.23.2](https://github.com/zeo-workspace/claude-agent-acp-plus/compare/v0.23.1...v0.23.2) (2026-10-03)


### Bug Fixes

* **deps:** @modelcontextprotocol/sdk 1.31.0 -&gt; 1.32.0, clearing GHSA-22jm-h49p-29qw and GHSA-6prh-2h8m-c8cw ([12d567a](https://github.com/zeo-workspace/claude-agent-acp-plus/commit/12d567aac0479305f0a7be8b1c80006806332a54))

## [0.23.1](https://github.com/zeo-workspace/claude-agent-acp-plus/compare/v0.23.0...v0.23.1) (2026-10-03)


### Bug Fixes

* **deps:** @modelcontextprotocol/sdk 1.30.0 -&gt; 1.31.0, clearing GHSA-6qxp-vccf-f47h ([52989ac](https://github.com/zeo-workspace/claude-agent-acp-plus/commit/52989ace7c59ed7e808890ef7bcdf5c95e9fd2ee))


### Miscellaneous Chores

* point repository URLs at the zeo-workspace organization ([66f4055](https://github.com/zeo-workspace/claude-agent-acp-plus/commit/66f405570bd0bc578ddac4f8fbb24b80cfe87fef))


### Continuous Integration

* run the gitleaks CLI instead of gitleaks-action ([45a6310](https://github.com/zeo-workspace/claude-agent-acp-plus/commit/45a6310b39dca71ba981db8209213acedf91d744))

## [0.23.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.22.2...v0.23.0) (2026-09-30)


### Features

* **deps:** raise the agent SDK pin to 0.3.285, for CLI 2.1.285 and Sonnet 5.5 ([d46aa89](https://github.com/lucascouts/claude-agent-acp-plus/commit/d46aa8968addc6ceb90c95007eb90da54aa4a4f5))


### Bug Fixes

* **session:** route consumer updates to the ACP session after a context clear ([f1ab0d9](https://github.com/lucascouts/claude-agent-acp-plus/commit/f1ab0d94c3d0c8ff0fee171933cf5981f473f0a0))

## [0.22.2](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.22.1...v0.22.2) (2026-09-29)


### Bug Fixes

* **usage:** render /usage from the CLI's synthetic frame and log every fallback ([#123](https://github.com/lucascouts/claude-agent-acp-plus/issues/123)) ([ccc5101](https://github.com/lucascouts/claude-agent-acp-plus/commit/ccc5101bacc1e24875f78506046caf2d9ec7f669))

## [0.22.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.22.0...v0.22.1) (2026-09-29)


### Bug Fixes

* **elicitation:** keep multi-select answers when a custom answer is typed ([a12a8c4](https://github.com/lucascouts/claude-agent-acp-plus/commit/a12a8c425ecf31dd612b138ebedd966f6bd9798b))
* **elicitation:** keep the picked option when custom text is also supplied ([05245ad](https://github.com/lucascouts/claude-agent-acp-plus/commit/05245ad461b401146ab00d7c14835ffcb45e84bf))
* **replay:** a reopened compacted thread replays from its first prompt ([ead5647](https://github.com/lucascouts/claude-agent-acp-plus/commit/ead5647106e45dea9805cfaf4f7cb3f2da36d1fd))
* **thinking:** a fresh thread's first turn no longer carries the recreate note ([26628e9](https://github.com/lucascouts/claude-agent-acp-plus/commit/26628e96e45eb06034d382c71f2f8da3d368c511))

## [0.22.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.21.0...v0.22.0) (2026-09-29)


### Features

* **notices:** send live advisories as ACP session notices ([46a0457](https://github.com/lucascouts/claude-agent-acp-plus/commit/46a045758e5817e9ca67b6377a82883f9c05be03))


### Miscellaneous Chores

* **deps:** bump github/codeql-action/upload-sarif in the actions group ([#119](https://github.com/lucascouts/claude-agent-acp-plus/issues/119)) ([77da1a7](https://github.com/lucascouts/claude-agent-acp-plus/commit/77da1a7caeffc34597d6a026531b50b6ea94009b))
* **deps:** bump the minor group across 1 directory with 14 updates ([#120](https://github.com/lucascouts/claude-agent-acp-plus/issues/120)) ([47fab64](https://github.com/lucascouts/claude-agent-acp-plus/commit/47fab64920a8cbcd4101e71fd0533f9eae22fd0f))

## [0.21.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.20.3...v0.21.0) (2026-09-27)


### Features

* **session:** publish the live background-task set to the client ([789cdf2](https://github.com/lucascouts/claude-agent-acp-plus/commit/789cdf216fdfdfc214c9c19c276a77621d4379a3))

## [0.20.3](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.20.2...v0.20.3) (2026-09-26)


### Bug Fixes

* **permissions:** honor permissions.disableBypassPermissionsMode ([bfc8b7a](https://github.com/lucascouts/claude-agent-acp-plus/commit/bfc8b7a92019a703a4a74c9ea057f24500387890))
* **session:** recreate a resumed session whose additional directories changed ([dbbda9d](https://github.com/lucascouts/claude-agent-acp-plus/commit/dbbda9dd476887391ea028efa984cb9b1daae67e))

## [0.20.2](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.20.1...v0.20.2) (2026-09-26)


### Bug Fixes

* **auth:** read "Please run /login" as a sign-out only on an error result ([f3f9c6d](https://github.com/lucascouts/claude-agent-acp-plus/commit/f3f9c6d1cd0e553e7a6d4b8c82fe4d207c89d89b))
* **compaction:** close the three interruption paths the audit found ([d687a14](https://github.com/lucascouts/claude-agent-acp-plus/commit/d687a146dec50063c1af8a5798d9a5ac13444aed))
* **plan:** continue a clear-context plan approved in a background followup ([9eb23bc](https://github.com/lucascouts/claude-agent-acp-plus/commit/9eb23bcd34b90d2155d66d78bcdd9f92a8e37199))
* **plan:** offer bypass alongside auto when approving a plan ([41982be](https://github.com/lucascouts/claude-agent-acp-plus/commit/41982bef49400ebeb63ca81584f9a57738a5152a))
* **plan:** publish the effective mode after a plan is approved ([7889619](https://github.com/lucascouts/claude-agent-acp-plus/commit/788961976a59fcf06a6f12f72c12e702d9217668))
* **replay:** replay marker-only slash skill prompts ([c9cfe04](https://github.com/lucascouts/claude-agent-acp-plus/commit/c9cfe04b7927d1a3972200229633c311416c7c25))
* **startup:** keep the agent starting when the managed-policy tier cannot be read ([ec5fedd](https://github.com/lucascouts/claude-agent-acp-plus/commit/ec5fedd886be4ca91cc131c9c66aee9116384c74))
* **tools:** render Write calls that use the path/file_text aliases ([2727eed](https://github.com/lucascouts/claude-agent-acp-plus/commit/2727eed3a236fc13550f2123cb44369cbc6567da))
* **usage:** keep the context meter when a synthetic frame follows a real one ([bc67f70](https://github.com/lucascouts/claude-agent-acp-plus/commit/bc67f70d210d64c717e2166889b2860f370f3705))


### Miscellaneous Chores

* **deps-dev:** bump prettier from 3.9.7 to 3.9.8 in the minor group ([#114](https://github.com/lucascouts/claude-agent-acp-plus/issues/114)) ([924dfcc](https://github.com/lucascouts/claude-agent-acp-plus/commit/924dfccc1437a0a4b973fa862eca093aeea978a5))

## [0.20.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.20.0...v0.20.1) (2026-09-23)


### Miscellaneous Chores

* **deps:** bump the minor group across 1 directory with 5 updates ([#112](https://github.com/lucascouts/claude-agent-acp-plus/issues/112)) ([06d834d](https://github.com/lucascouts/claude-agent-acp-plus/commit/06d834d5c069c1043d3c59a13f3fb73be13568a9))

## [0.20.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.19.0...v0.20.0) (2026-09-23)


### Features

* **models:** offer only the newest model of each family in the picker ([3296fd2](https://github.com/lucascouts/claude-agent-acp-plus/commit/3296fd2cb054854770024ba5c01dfb9ac2c955da))


### Miscellaneous Chores

* **deps:** raise the agent SDK pin to 0.3.280, for CLI 2.1.280 ([2bbd4be](https://github.com/lucascouts/claude-agent-acp-plus/commit/2bbd4becc155eb067e92a672ea3c61b58fcca276))
* **deps:** take the fork's 0.3.273, and say what still holds the pin ([8410929](https://github.com/lucascouts/claude-agent-acp-plus/commit/8410929091edeed55599265be0e3ee8a47f28f00))


### Documentation

* **compaction:** the fifth copy, in the repository that publishes ([50df2c7](https://github.com/lucascouts/claude-agent-acp-plus/commit/50df2c704eb0435e34e600c6ec69a96846fdb071))

## [0.19.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.18.0...v0.19.0) (2026-09-22)


### Features

* **session-failure:** say what a no-response retry waited for, and for how long ([952bb10](https://github.com/lucascouts/claude-agent-acp-plus/commit/952bb10911ded6fe01cd360cf49960a2a517670c))
* **turn:** sweep unpayable trailing-idle debt at the running transition ([253b9c8](https://github.com/lucascouts/claude-agent-acp-plus/commit/253b9c8d3ed582353e225ca4a65056dd226490ce))


### Bug Fixes

* **deps:** pin the agent SDK back to 0.3.269, below the CLI 2.1.270 cliff ([cddfd82](https://github.com/lucascouts/claude-agent-acp-plus/commit/cddfd82fc3c14266950bc020ef74aca5b6a0baef))


### Miscellaneous Chores

* **deps-dev:** bump nanoid from 3.3.18 to 3.3.19 ([#103](https://github.com/lucascouts/claude-agent-acp-plus/issues/103)) ([4ccfb3c](https://github.com/lucascouts/claude-agent-acp-plus/commit/4ccfb3cc548ff4d01d220a0246e3716951d47713))
* **deps-dev:** bump obug from 2.1.4 to 2.2.1 ([#104](https://github.com/lucascouts/claude-agent-acp-plus/issues/104)) ([6ee1755](https://github.com/lucascouts/claude-agent-acp-plus/commit/6ee1755fda6c0fdf59babc1cd8834be2212adaa0))
* **deps:** bump fast-uri from 3.1.7 to 3.1.8 ([#109](https://github.com/lucascouts/claude-agent-acp-plus/issues/109)) ([e9824a8](https://github.com/lucascouts/claude-agent-acp-plus/commit/e9824a872fdbed7c3430615bd80ab87c488256fe))
* **deps:** bump the actions group with 2 updates ([#105](https://github.com/lucascouts/claude-agent-acp-plus/issues/105)) ([d93a6eb](https://github.com/lucascouts/claude-agent-acp-plus/commit/d93a6ebde15b16202d6fc6b82455643067abc10d))
* **deps:** bump the minor group across 1 directory with 14 updates ([#106](https://github.com/lucascouts/claude-agent-acp-plus/issues/106)) ([e1db876](https://github.com/lucascouts/claude-agent-acp-plus/commit/e1db8767abd1264a1409b6e4a4fb4b01e1fd9177))
* **deps:** bump the minor group with 4 updates ([#108](https://github.com/lucascouts/claude-agent-acp-plus/issues/108)) ([2c879ff](https://github.com/lucascouts/claude-agent-acp-plus/commit/2c879ffd2a8ac5252913f3043169860a559631f9))


### Continuous Integration

* **dependabot:** stop proposing agent SDK bumps, which are ports not bumps ([af10bdd](https://github.com/lucascouts/claude-agent-acp-plus/commit/af10bdd6c9796450c3a45c7e769c6a8dc44fc2da))

## [0.18.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.17.0...v0.18.0) (2026-09-19)


### Features

* **permissions:** honour the CLI's defaultToNo and suppressAlwaysAllowRule ([170cb69](https://github.com/lucascouts/claude-agent-acp-plus/commit/170cb69218b211d166280eef55fea79637f459be))


### Bug Fixes

* **diff:** stop rendering the EOF marker as a line of the file ([ab35925](https://github.com/lucascouts/claude-agent-acp-plus/commit/ab35925ff8602675d3cadb4cefb51bd06118c615))
* **permissions:** show the shell command being approved, not its description ([52719aa](https://github.com/lucascouts/claude-agent-acp-plus/commit/52719aad2beb36449b7c901413ebd94cb2986db2))


### Miscellaneous Chores

* **deps:** bump the minor group across 1 directory with 26 updates ([#99](https://github.com/lucascouts/claude-agent-acp-plus/issues/99)) ([ca005a7](https://github.com/lucascouts/claude-agent-acp-plus/commit/ca005a79d8f625b5d40726ca6a0615faf7788922))

## [0.17.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.16.0...v0.17.0) (2026-09-19)


### Features

* **tools:** carry the standard ACP `name` on the initial tool_call ([ffac107](https://github.com/lucascouts/claude-agent-acp-plus/commit/ffac107bbccdb1aa6dcb2cb99d451aa4be586d0f))


### Bug Fixes

* **replay:** strip injected system reminders from replayed prompts ([3cb0462](https://github.com/lucascouts/claude-agent-acp-plus/commit/3cb0462284b4f45d4de28b724cc654dc7d759ec3))


### Miscellaneous Chores

* **deps:** raise the agent SDK pin to 0.3.263 ([56d51e3](https://github.com/lucascouts/claude-agent-acp-plus/commit/56d51e3a6ab61c17f18d92905b6d5ab42d58097b))

## [0.16.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.15.2...v0.16.0) (2026-09-12)


### Features

* **resume:** read the live model from the transcript, not only from the report ([8e7a783](https://github.com/lucascouts/claude-agent-acp-plus/commit/8e7a783707f948235c5afb372837143da5b28c1b))


### Continuous Integration

* local exit 0 -- 1196 passed, 31 skipped. ([8e7a783](https://github.com/lucascouts/claude-agent-acp-plus/commit/8e7a783707f948235c5afb372837143da5b28c1b))

## [0.15.2](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.15.1...v0.15.2) (2026-09-11)


### Miscellaneous Chores

* **deps-dev:** bump vitest from 4.1.11 to 5.0.0 ([#92](https://github.com/lucascouts/claude-agent-acp-plus/issues/92)) ([7d42e18](https://github.com/lucascouts/claude-agent-acp-plus/commit/7d42e183245affa3f4df23f493f5fb020df3b953))

## [0.15.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.15.0...v0.15.1) (2026-09-09)


### Bug Fixes

* **usage:** an API-key session shares nothing, so the key never reaches a hash ([1606b98](https://github.com/lucascouts/claude-agent-acp-plus/commit/1606b98baff993ed6117a17417e5e3f549a37310))

## [0.15.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.14.0...v0.15.0) (2026-09-09)


### Features

* **usage:** one quota sample per machine, shared between adapter processes ([f46da14](https://github.com/lucascouts/claude-agent-acp-plus/commit/f46da14e3a696544c0d182bf5920380e3d6def8f))

## [0.14.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.13.0...v0.14.0) (2026-09-08)


### Features

* **usage:** refresh the quota windows while the session is idle ([f925bfb](https://github.com/lucascouts/claude-agent-acp-plus/commit/f925bfbc50efdb2abbad78dec85317d39803731a))


### Miscellaneous Chores

* **deps:** bump the actions group with 2 updates ([#88](https://github.com/lucascouts/claude-agent-acp-plus/issues/88)) ([869f275](https://github.com/lucascouts/claude-agent-acp-plus/commit/869f2758d5c91906ef116264c9f987d88bc63b36))

## [0.13.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.12.0...v0.13.0) (2026-09-05)


### Features

* **adapter:** report compaction and render /usage instead of inferring and forwarding ([fc6d4d8](https://github.com/lucascouts/claude-agent-acp-plus/commit/fc6d4d8daf6ad1ce448426feb228c4282ca07e22))
* **session:** the account is a session property, not an agent ([65e0a69](https://github.com/lucascouts/claude-agent-acp-plus/commit/65e0a69551918a3d731cfd6a143c7592f212cb40))


### Bug Fixes

* **attribution:** join a result to its turn by user_message_uuid ([a83e26c](https://github.com/lucascouts/claude-agent-acp-plus/commit/a83e26cd768eefab76b74bf2f0e4a14282481a27))

## [0.12.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.11.1...v0.12.0) (2026-09-05)


### Features

* **effort:** offer Ultracode in the effort picker ([704824c](https://github.com/lucascouts/claude-agent-acp-plus/commit/704824c3f89f6407a7d356a974e935865c97f491))


### Build System

* **deps:** take every shared pin to the registry's latest, cooldown waived ([389078a](https://github.com/lucascouts/claude-agent-acp-plus/commit/389078adfff6f38994eee9837c4c151b6d5fb911))

## [0.11.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.11.0...v0.11.1) (2026-09-05)


### Miscellaneous Chores

* **release:** let the changelog record the dependency work it never recorded ([#84](https://github.com/lucascouts/claude-agent-acp-plus/issues/84)) ([3d59466](https://github.com/lucascouts/claude-agent-acp-plus/commit/3d59466deb9322b6249de543765196af9d5136fe))

## [0.11.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.10.1...v0.11.0) (2026-09-05)


### Features

* **usage:** report every quota window from the structured usage report ([#82](https://github.com/lucascouts/claude-agent-acp-plus/issues/82)) ([0ae5149](https://github.com/lucascouts/claude-agent-acp-plus/commit/0ae51496692f81f75a65a4a01a6ed6f57f26b2d2))

## [0.10.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.10.0...v0.10.1) (2026-09-02)


### Miscellaneous Chores

* release 0.10.1 ([#74](https://github.com/lucascouts/claude-agent-acp-plus/issues/74)) ([eca4a98](https://github.com/lucascouts/claude-agent-acp-plus/commit/eca4a982cb97f218096e26d82e4ec5a316e1d87a))

## [0.10.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.9.0...v0.10.0) (2026-09-02)


### Features

* **acp:** defer steering while input is pending, and align the SDK ([71a6a64](https://github.com/lucascouts/claude-agent-acp-plus/commit/71a6a64c63a1587ff9ffb442551c88f4cab6bfd0))


### Bug Fixes

* **tools:** parse a TaskList line in linear time ([#73](https://github.com/lucascouts/claude-agent-acp-plus/issues/73)) ([1ed41b0](https://github.com/lucascouts/claude-agent-acp-plus/commit/1ed41b03e1872531a55e65ba4c991310e4a75d1c))

## [0.9.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.8.1...v0.9.0) (2026-08-27)


### Features

* port upstream v0.70.0 — permissions extracted into modules, session titles, task-plan persistence ([68777a7](https://github.com/lucascouts/claude-agent-acp-plus/commit/68777a73c4f450ba926a1e8b5cd913add11bed1b))

## [0.8.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.8.0...v0.8.1) (2026-08-23)


### Bug Fixes

* drop claude-code-guide from the built-in agent roster ([36a9ac6](https://github.com/lucascouts/claude-agent-acp-plus/commit/36a9ac6fb5122f8c52145f544ca6d27cf2da7d51))
* **test:** accept the SDK's requestId in the dialog callback options ([5d823b5](https://github.com/lucascouts/claude-agent-acp-plus/commit/5d823b503d3cf5b16cb0dff72fa6be75b50e7c3b))

## [0.8.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.7.0...v0.8.0) (2026-08-23)


### Features

* **ci:** attest release-PR checks locally with act and commit statuses ([12a2fa8](https://github.com/lucascouts/claude-agent-acp-plus/commit/12a2fa861154a4789394c9a08ce1553c3ca24413))


### Bug Fixes

* **ci:** attest gitleaks by running its scan, not by waiving its job ([65f8079](https://github.com/lucascouts/claude-agent-acp-plus/commit/65f8079fca985b80c5a62ed57292bedacbe0f7bf))
* **ci:** calibrate the environmental gaps against a real act run ([e47b149](https://github.com/lucascouts/claude-agent-acp-plus/commit/e47b1496e617417ec31daae906bfa39822743176))
* **ci:** require the PR head commit before attesting anything ([957a582](https://github.com/lucascouts/claude-agent-acp-plus/commit/957a582fce9a5bf6838f5ff9fc683f35d2548875))

## [0.7.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.6.0...v0.7.0) (2026-08-07)


### Features

* port upstream v0.66.0 — reliable goal publication with the set action ([#48](https://github.com/lucascouts/claude-agent-acp-plus/issues/48)) ([9e87cd2](https://github.com/lucascouts/claude-agent-acp-plus/commit/9e87cd297988a6ca1429277de9390fee500157de))

## [0.6.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.5.2...v0.6.0) (2026-08-07)


### Features

* port upstream v0.65.0 — provider-neutral ACP goal extension ([0f4fd18](https://github.com/lucascouts/claude-agent-acp-plus/commit/0f4fd181579edf06d383df0b008e4ba7faf76682))

## [0.5.2](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.5.1...v0.5.2) (2026-08-06)


### Bug Fixes

* **permissions:** keep the Always Allow scope visible in the option label ([e931b06](https://github.com/lucascouts/claude-agent-acp-plus/commit/e931b06d58b60d39d2f5d2bdabc4672473870a41))

## [0.5.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.5.0...v0.5.1) (2026-08-05)


### Bug Fixes

* **deps:** resolve 7 advisories via security overrides ([#40](https://github.com/lucascouts/claude-agent-acp-plus/issues/40)) ([c7cb7a7](https://github.com/lucascouts/claude-agent-acp-plus/commit/c7cb7a73c50795cdb21d209d08c3663db0dbed3a))

## [0.5.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.4.0...v0.5.0) (2026-08-01)


### Features

* prune the fallback and sync upstream v0.64.0 (port from fork) ([f0b30f9](https://github.com/lucascouts/claude-agent-acp-plus/commit/f0b30f9d6f3c9c22aa41e874f9503e8b70309c43))

  **`ACP_ASKUSERQUESTION_FALLBACK` no longer exists.** The AskUserQuestion
  permission fallback is gone entirely — the module, its two suites, and all
  four wiring sites, which return to upstream's own wording. It was added when
  Zed gated `elicitation.form` behind its acp-beta flag; Zed now advertises form
  elicitation unconditionally, so the code was unreachable in the only client
  that consumed it. Setting the variable has no effect, because nothing reads
  it. A client that does **not** advertise form elicitation no longer sees the
  AskUserQuestion tool at all — upstream's stance.

  Upstream v0.64.0 closes a five-release gap (v0.59.0 → v0.64.0). The
  user-visible win is upstream #894: session creation and model switching lose
  a ~15 s stall.


### Bug Fixes

* **deps:** pin brace-expansion to 5.0.8 to clear GHSA-mh99-v99m-4gvg ([38b8de3](https://github.com/lucascouts/claude-agent-acp-plus/commit/38b8de316799df5bb2358b73a8b7d99e493f39e1))
* **rewind:** report link-safety refusals instead of claiming full success (port from fork) ([10ac37a](https://github.com/lucascouts/claude-agent-acp-plus/commit/10ac37ad2dd56bd13448e7753eec1c2bdc878dc6))

  SDK 0.3.220 added `RewindFilesResult.skippedLinks`, a count of tracked files
  the SDK did **not** restore — a symlink, hard link or other non-regular file
  sits at the tracked path, the parent directory no longer resolves where it
  pointed, or the backup could not be safely read. The adapter ignored it, so
  `/rewind <n>` reported the same unqualified success whether every file was
  restored or half of them were silently refused. It now says so: `1 file was` /
  `N files were left unchanged for link safety.` A rewind that refused nothing
  is byte-identical to before.


### Security

* the project's own ReDoS fix is reverted, superseded upstream ([f0b30f9](https://github.com/lucascouts/claude-agent-acp-plus/commit/f0b30f9d6f3c9c22aa41e874f9503e8b70309c43))

  The polynomial-ReDoS rewrite shipped in 0.4.0 (CWE-1333, in subagent trailer
  stripping) is removed in favour of upstream's own fix in v0.60.0
  (agentclientprotocol/claude-agent-acp#879); our report, issue #893, is closed.
  The vulnerability remains fixed — the implementation is now upstream's rather
  than ours, which is what keeps `src/tools.ts` byte-identical to upstream and
  out of every future sync's conflict set.

  **Two observable behaviours change, both conservative — upstream truncates
  less:**

  - `<usage>` stripping now anchors on the **last** opening marker rather than
    the first. A report that merely quotes `<usage>` earlier in its text keeps
    that quote, instead of having everything from it onward removed.
  - The `agentId:` trailer must now occupy a **whole final line** to be
    stripped. A report mentioning `agentId:` mid-line keeps that text, where the
    previous implementation located the trailer from the last `(` and truncated
    there.

  A fork-owned test suite pins both divergences so a future sync cannot silently
  reintroduce the old semantics.

## [0.4.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.3.0...v0.4.0) (2026-07-19)


### Features

* port upstream v0.59.0 (configurable LLM providers, subagent fixes) ([#14](https://github.com/lucascouts/claude-agent-acp-plus/issues/14)) ([dd7dc4d](https://github.com/lucascouts/claude-agent-acp-plus/commit/dd7dc4d6a9c0aa54db4b438d46c378770e8e28e5))


### Security

* remove polynomial ReDoS (CWE-1333) in subagent trailer stripping ([#14](https://github.com/lucascouts/claude-agent-acp-plus/issues/14)) ([dd7dc4d](https://github.com/lucascouts/claude-agent-acp-plus/commit/dd7dc4d6a9c0aa54db4b438d46c378770e8e28e5))

  The `<usage>` / `agentId:` trailer patterns inherited from upstream v0.59.0
  were tail-anchored but not start-anchored, so the engine retried from every
  position — O(n²) on text repeating an opening token, which a subagent can
  echo verbatim into the `tool_result` its report is parsed from. Rewritten
  with index matching (constant-time on the same input), semantics verified
  identical against the original on 200k randomized cases.

## [0.3.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.2.0...v0.3.0) (2026-07-11)


### Features

* sync with upstream claude-agent-acp v0.58.1 ([84e291f](https://github.com/lucascouts/claude-agent-acp-plus/commit/84e291f8151ea222f8f445b7abfadb3a9b8633a9))

## [0.2.0](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.1.1...v0.2.0) (2026-07-08)


### Features

* parity round 2 (port from fork) ([217011a](https://github.com/lucascouts/claude-agent-acp-plus/commit/217011a55b120735235600a83ab422ce26821473))

## [0.1.1](https://github.com/lucascouts/claude-agent-acp-plus/compare/v0.1.0...v0.1.1) (2026-07-08)


### Miscellaneous Chores

* **package:** describe the fork's value in the npm listing ([05cf597](https://github.com/lucascouts/claude-agent-acp-plus/commit/05cf59794f7ae365d83d063acbab001bf1409eaa))

## 0.1.0 (2026-07-08)

Initial release of `@lucascouts/claude-agent-acp-plus`, rebased on upstream
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
v0.57.0.

### Highlights

- Refusal-fallback consent dialog inherited from upstream v0.55.0.
- AskUserQuestion permission fallback (multiSelect → checkbox).
- Dynamic agent name derived from package.json.
- Dependencies at latest workable versions: all devDependencies at registry
  latest; runtime SDKs kept at the upstream v0.57.0 pins after breakage
  attribution.
