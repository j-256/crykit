# Steal mechanics

This note records the steal behavior verified from the Windows PC build of Crystal Project rather than treating guide or wiki descriptions as executable rules. The inspected `Crystal Project.exe` has assembly version `1.6.9.0` and SHA-256 `36f7d413160a4deee36b47fc6ac534e87cadb6f23f57337d4630ec99cedb14e6`. The executable methods `BattlerMonster.SetupLootSteals`, `Calculator.CalculateStealChance`, `Calculator.CalculateLuckFactor`, `RollResolver.ResolveSteal`, and `AbilityProcessor.ResolveAbilityMod` establish the calculation and resolution order. The shipped `monster.dat`, `ability.dat`, and `equipment.dat` files supply the inputs described below.

This evidence applies to that PC build. It does not establish Nintendo Switch or mod-pack parity. The [calculation package](calculations.md#damage-scope) exports native steal arithmetic with explicit inputs and random draws; the planner does not offer an interactive steal-outcome simulation.

## Inputs and integer behavior

For one stealable entry:

| Symbol | Meaning |
|---|---|
| `H` | The entry's `LootChance`, from 0 through 100 |
| `S` | The entry's `StealChance`, normally from 0 through 100 |
| `B` | The stealing battler's total `StealChanceUp` stat |
| `L` | The stealing battler's current Luck stat |
| `F` | The calculated luck factor |
| `N` | The battler's `ConsecutiveFailedMisc` counter before the item check |
| `C` | The entry's base steal chance after `StealChanceUp` |
| `A` | The entry's execution-time chance after failure protection |

`trunc(x)` means conversion to a signed integer by discarding the fractional part. For the nonnegative values used by ordinary steal calculations, this is the same as floor. Integer multiplication and division occur in the order shown. The random test is an inclusive, uniformly distributed integer from 1 through 100.

## Availability is separate from stealing

When a monster is set up for battle, every `ItemSteals` entry receives an independent availability roll:

```text
available = d100 <= H
```

Only entries that pass this roll are added to the monster's runtime `LootSteals` list. Luck and `StealChanceUp` do not modify this roll. An unavailable entry cannot be obtained by repeated Steal attempts in that encounter. The battle UI says that the target has nothing to steal when the runtime list is empty.

For example, an entry with `LootChance = 20` and `StealChance = 10` first has a 20% chance to be available. If it is available, each attempt starts from the separate 10% steal rate before the modifiers below.

## Base chance and StealChanceUp

The game calculates the base chance for each available entry as:

```text
C = trunc(100 * (S + B) / (100 + B))
```

Positive `StealChanceUp` values therefore have diminishing returns. They are not flat percentage-point additions and do not multiply `S`. With `S = 25` and `B = 15`, the result is `trunc(100 * 40 / 115) = 34`, not 40 or 28. With `S = 1` and `B = 35`, the result is `trunc(100 * 36 / 135) = 26`.

All contributing stat modifiers add into `B` before this formula runs. In the inspected database, stat-modifier tag `526` is `StealChanceUp`. The shipped equipment sources are Burglar's Glove `+15`, Knicked Knackers `+20`, Mugger's Glove `+35`, Pirate Hat `+35`, and Captain's Hat `+20`; ordinary equipment legality still determines which combination can be active.

For every finite nonnegative `B` and every `S < 100`, the unrounded result remains below 100. An ordinary positive `StealChanceUp` modifier can approach guaranteed success but cannot reach it.

## Luck and failure protection

The general luck helper begins with the user's Luck. If the executing ability contains `LuckUp [X]`, it first applies:

```text
effectiveLuck = trunc(L * (100 + X) / 100)
```

It then calculates:

```text
F = max(0, trunc((effectiveLuck - trunc(targetLuck / 2)) * 0.75))
```

Steal resolution passes the stealing battler as both the user and the target of this helper. The shipped Steal and Mug abilities contain the Steal modifier but no `LuckUp` modifier, so their formula simplifies to:

```text
F = trunc((L - trunc(L / 2)) * 0.75)
  = trunc(0.75 * ceil(L / 2))
```

The monster's Luck is not used. Luck also does not directly increase the first check when the failure counter is zero. It controls the amount added for each prior failed miscellaneous roll:

```text
A = C + trunc(C * F / 100) * N
success = d100 <= A
```

There is no explicit clamp to 100. Any `A >= 100` succeeds because the random result cannot exceed 100. A success resets `ConsecutiveFailedMisc` to zero, while a failure increments it by one.

The counter belongs to the acting battler, starts at zero when the battle starts, and is cleared when the battle ends. Failed Steal checks, failed Escape checks, and failed `ChanceForDamageMult` checks share it. A success in any of those checks resets it, so the next steal chance can depend on more than earlier Steal uses.

For example, with `C = 50` and `L = 100`, the luck factor is 37 and each failure adds `trunc(50 * 37 / 100) = 18` points. Success chances with `N` equal to 0, 1, 2, and 3 are therefore 50%, 68%, 86%, and 104%. The fourth value is effectively guaranteed.

## Several available entries

A Steal modifier checks the target's available entries in runtime list order and stops after the first success. The successful entry is removed and awarded, so one modifier steals at most one entry. Every unsuccessful entry check increments `ConsecutiveFailedMisc` before the next entry is checked.

For an initial counter `N0`, entry `i` on the all-previous-entries-failed path uses:

```text
A_i = C_i + trunc(C_i * F / 100) * (N0 + i - 1)
q_i = min(100, max(0, A_i)) / 100
```

The code does not contain the clamp written in `q_i`; it follows from comparing an inclusive `d100` to `A_i`. The exact probability that at least one of `m` available entries succeeds is:

```text
P(actual success) = 1 - product(i = 1..m, 1 - q_i)
```

The battle preview does not include Luck or the failure counter. It combines only the base chances using single-precision floating-point arithmetic:

```text
D_0 = 0
D_i = D_(i - 1) + (100 - D_(i - 1)) * C_i / 100
displayedChance = trunc(D_m)
```

Apart from floating-point precision, that recurrence is equivalent to:

```text
displayedChance = trunc(100 * (1 - product(i = 1..m, 1 - C_i / 100)))
```

Because failed checks within the same Steal use increase the counter, the execution-time probability can exceed the displayed percentage even when the counter began at zero.

## Guaranteed-attempt mod and the `-20000` value

The direct content-data approach is to set every affected `ItemSteals[].StealChance` to 100 while leaving `LootChance` unchanged. A smaller global or toggleable mod can instead exploit the signed denominator in the `StealChanceUp` formula. This is an implementation quirk, not the intended meaning of a negative chance bonus.

Let the total `StealChanceUp` be `B = -K`, where `K > 100`. The base formula becomes:

```text
C = trunc(100 * (S - K) / (100 - K))
  = trunc(100 * (K - S) / (K - 100))
  = trunc(100 + 100 * (100 - S) / (K - 100))
```

For every ordinary `S` from 0 through 100, this value is at least 100 whenever the total `B` is below `-100`, so every attempt succeeds. Values close to `-100` can display well above 100. To make the integer result exactly 100 for the entire `S = 0..100` range, the largest fractional excess, at `S = 0`, must remain below one:

```text
100 * 100 / (K - 100) < 1
K > 10100
```

Since `K` is an integer, any total `B <= -10101` produces exactly 100 for every `S` from 0 through 100. The recommended magic modifier is deliberately farther from the boundary:

```json
{
  "Tag": 526,
  "Value1": -20000,
  "Value2": 0,
  "Value3": 0
}
```

With no other modifiers, substituting `B = -20000` gives:

```text
C = trunc(100 * (20000 - S) / 19900)
```

The unrounded result ranges from exactly 100 at `S = 100` to approximately 100.503 at `S = 0`, so integer truncation makes every result exactly 100. Because the game sums all sources into `B`, `-20000` also leaves room for up to 9,899 points of positive `StealChanceUp` while preserving the exact-100 condition. The guarantee remains, although the displayed value may exceed 100, whenever the final total stays below `-100`.

A final total of exactly `-100` makes the denominator zero and causes a division-by-zero failure. A mod using this technique must keep the total far from that value and should hide the raw negative stat text behind an explicit description such as "Steal attempts always succeed." This modifier changes attempt success only; it does not change `LootChance` or add stealable entries to monsters that have none.
