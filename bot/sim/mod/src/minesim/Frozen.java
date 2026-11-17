package minesim;

import net.minecraft.class_3222;

// Names are Fabric intermediary for 1.21.11 (the mod is compiled against server-intermediary.jar, no remapping):
//   class_3222 = ServerPlayer, method_51469 = ServerPlayer.level() -> ServerLevel,
//   method_54719 = Level.tickRateManager(), method_54751 = TickRateManager.runsNormally()
// runsNormally() is false while `tick freeze` is on and no `tick step` tick is running.
public final class Frozen {
  private Frozen() {}

  public static boolean player(class_3222 p) {
    return !p.method_51469().method_54719().method_54751();
  }
}
