package minesim.mixin;

import minesim.Frozen;
import net.minecraft.class_3222;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

// ServerPlayer.tick() (method_5773), run by the level's entity loop on every server loop iteration: vanilla never
// freezes players (TickRateManager.isEntityFrozen). Skip it while frozen so it runs once per stepped tick.
@Mixin(class_3222.class)
public abstract class PlayerTickMixin {
  @Inject(method = "method_5773", at = @At("HEAD"), cancellable = true)
  private void minesim$freeze(CallbackInfo ci) {
    if (Frozen.player((class_3222) (Object) this)) ci.cancel();
  }
}
