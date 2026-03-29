// Resonite Script — Game Loop Pattern
// Demonstrates lifecycle hooks and entity manipulation

this.onStart = function () {
  this.vars.speed = 2.0;
  this.vars.health = 100;
  this.vars.direction = { x: 0, y: 0, z: 1 };
  this.vars.isAlive = true;

  this.log('Game started! Health: ' + this.vars.health);
};

this.onUpdate = function () {
  if (!this.vars.isAlive) return;

  // Move entity forward
  const pos = this.entity.Get('position');
  const dir = this.vars.direction;
  const dt = this.deltaTime;

  this.entity.Set('position', {
    x: pos.x + dir.x * this.vars.speed * dt,
    y: pos.y + dir.y * this.vars.speed * dt,
    z: pos.z + dir.z * this.vars.speed * dt,
  });

  // Rotate slowly
  const rot = this.entity.Get('rotation');
  this.entity.Set('rotation', {
    x: rot.x,
    y: rot.y + 0.01,
    z: rot.z,
    w: rot.w,
  });
};

this.onImpulse = function (tag) {
  if (tag === 'hit') {
    this.vars.health -= 10;
    this.log('Ouch! Health: ' + this.vars.health);
    this.sendToResonite('playSound:hit');

    if (this.vars.health <= 0) {
      this.vars.isAlive = false;
      this.log('Game over!');
      this.sendToResonite('setText:Game Over');
    }
  }

  if (tag === 'heal') {
    this.vars.health = Math.min(100, this.vars.health + 25);
    this.log('Healed! Health: ' + this.vars.health);
  }
};

this.onDestroy = function () {
  this.log('Game loop stopped');
};
