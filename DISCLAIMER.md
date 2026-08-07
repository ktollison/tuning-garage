# Read this before you flash anything

Engine calibration is not a software hobby with software consequences. The
failure modes are mechanical, expensive, and fast.

**A wrong calibration can destroy an engine in seconds.** A lean mixture or too
much ignition advance under load can hole a piston, melt a ring land, or damage
bearings before any gauge you are watching has time to register it, let alone
before you can lift. There is no undo, and detonation does not announce itself
politely first.

**Writing to a control module can leave it unrecoverable.** An interrupted
write, a marginal interface, or an unstable power supply can brick a PCM. This
project exists partly because its author lost three of them learning that
lesson. Budget for the possibility that the module on your bench does not come
back.

**This software produces draft readings, not advice.** Everything it reports —
checksums, trims, air-fuel error, knock maps, suggested corrections — is
derived from data you supplied and definition files written by strangers.
Either can be wrong. A confident number on screen is still just arithmetic
performed on whatever it was given. Nothing here is a substitute for training,
proper instrumentation, a dynamometer, or an experienced tuner looking at your
particular combination.

**It never decides, and it never writes to your vehicle.** The app records,
analyses and organises. Every change is applied by you, by hand, in your tuning
software, on your authority.

**Legality is yours to check.** Modifying emissions-related calibrations may be
unlawful for road use where you live, and rules differ substantially between
jurisdictions and between road and competition use. Complying with them is the
operator's responsibility, not the tool's.

**No warranty, no liability.** This software and its documentation are provided
as-is, without warranty of any kind. The authors and contributors accept no
responsibility for damage to vehicles, control modules, property, or persons,
or for any loss arising from its use.

**You are accountable for what gets flashed.** If you are not prepared to lose
the module, the engine, or the vehicle, do not perform the write. Proceed at
your own risk.
