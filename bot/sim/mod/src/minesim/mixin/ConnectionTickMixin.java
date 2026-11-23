package minesim.mixin;

import minesim.Frozen;
import net.minecraft.class_3222;
import net.minecraft.class_3244;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

// ServerGamePacketListenerImpl.tickPlayer() (class_3244.method_73086), called by the connection tick on every
// server loop iteration: runs ServerPlayer.doTick() (air, regen, hunger, sleep, effects, fire...) and the floating
// kick counters. Return false (= not disconnected) without running it while frozen; the rest of the connection
// tick (keepalive, packets) still runs.
@Mixin(class_3244.class)
public abstract class ConnectionTickMixin {
  @Shadow public class_3222 field_14140; // player

  @Inject(method = "method_73086", at = @At("HEAD"), cancellable = true)
  private void minesim$freeze(CallbackInfoReturnable<Boolean> cir) {
    if (Frozen.player(field_14140)) cir.setReturnValue(false);
  }
}
