# BZCC ODF Documentation (vendored reference)

> **Source:** [Steam Community Guide: ODF Documentation](https://steamcommunity.com/sharedfiles/filedetails/?id=1423355866)
> **Authors:** GenBlackDragon and [BZ] Ultraken
> **Covers:** Battlezone: Combat Commander version 2.0.185
> **Guide posted:** Jul 24, 2018 -- **last updated:** May 10, 2026 -- **retrieved:** Jun 12, 2026
>
> Vendored verbatim (Steam page chrome stripped) so the ODF property semantics
> this project depends on -- weaponHard/weaponName slots, lightHard/lightName,
> wpnCategory codes, articulation names, class hierarchies -- stay grep-able,
> offline, and stable against upstream edits. Hand-written formatting is
> preserved; do NOT machine-parse this file, search it.

---

Guide Index

Overview 

Object Definition Files 

Common Terms 

Classlabel List 

AI Process Info 

AI Task Info 

AI Command List 

Configuration ODFs 

EntityClass 

GameObjectClass P1: General Settings 

GameObjectClass P2: General Settings 2 

GameObjectClass P3: Combat Settings 

GameObjectClass P4: Build Settings 

GameObjectClass P5: Model Settings 

BuildingClass 

CraftClass P1: General Settings 

CraftClass P2: General Settings 2 

CraftClass P3: General Settings 3 

CraftClass P4: AI Settings 

AircraftClass 

APCClass 

ArmoryClass 

ArtifactClass 

ArtilleryClass 

AssaultHoverClass 

AssaultTankClass 

BarracksClass 

BoidClass 

BomberClass 

BomberBayClass 

CameraPodClass 

CommBunkerClass 

CommTowerClass 

CommVehicleClass 

CommVehicleHClass 

ConstructionRigClass 

ConstructionRigTClass 

DayWreckerClass 

DeployableClass 

DeployBuildingClass 

DeployBuildingHClass 

DepositClass 

DummyClass 

ExtractorClass 

FactoryClass 

FlagObjectClass 

HoverCraftClass 

HowitzerClass 

JammerClass 

KingOfHillClass 

LandCreatureClass 

LightClass 

MineClass 

FlareMineClass 

MagnetMineClass 

ProximityMineClass 

TripMineClass 

WeaponMineClass 

SeekerClass 

SatchelChargeClass 

MinelayerClass 

MoneyPowerupClass 

MorphTankClass 

MotionSensorClass 

NavBeaconClass 

ObjectSpawnClass 

PersonClass 

PlantClass 

PoweredBuildingClass 

PowerPlantClass 

PowerUpClass 

RecyclerClass 

RecyclerVehicleClass 

RecyclerVehicleHClass 

SAVClass 

ScavengerClass 

ScavengerHClass 

ScrapClass 

ServicePowerup 

ServiceTruckClass 

ServiceTruckHClass 

ShieldTowerClass 

SiloClass 

SpawnBuoyClass 

SprayBuildingClass 

SupplyDepotClass 

TechCenterClass 

TelePortalClass 

TrackedDeployableClass 

TrackedVehicleClass 

TorpedoClass 

TugClass 

TurretCraftClass 

TurretTankClass 

WalkerClass 

WeaponPowerupClass 

WingmanClass 

WeaponClass 

ArcCannonClass 

BlinkDeviceClass 

CannonClass 

ChargeGunClass 

DamageFieldClass 

DispenserClass 

ForceFieldClass 

ImageLauncherClass 

ImageRefract 

JetPackClass 

LauncherClass 

MachineGunClass 

MagnetGunClass 

MortarClass 

MultiLauncherClass 

RadarDamperClass 

RadarLauncherClass 

RemoteDetonatorClass 

SalvoLauncherClass 

SatchelPackClass 

ShieldUpgradeClass 

SpecialItemClass 

TargetingGunClass 

TerrainExposeClass 

ThermalLauncherClass 

TorpedoLauncherClass 

OrdnanceClass 

AnchorRocketClass 

BeamClass 

BounceBombClass 

BulletClass 

GrenadeClass 

ImageMissileClass 

LaserMissileClass 

LaserPopperClass 

LeaderRoundClass 

LockShellClass 

MagnetShellClass 

MissileClass 

PopperClass 

PulseShellClass 

RadarMissileClass 

RadarPopperClass 

SeismicWaveClass 

SniperShellClass 

SprayBombClass 

ThermalMissileClass 

ExplosionClass 

QuakeBlastClass 

Comments 

 Object Definition Files 

 The game uses Object Definition Files to identify most Entities in the world.  
* **What is an Object Definition File?**  
    
The game uses Object Definition Files (.odf file extension) to identify all the properties of an Entity in the game. Everything from buildings, ships, weapons, explosions, are all defined by ODFs.
* **How do I edit an Object Definition File?**  
    
The ODFs can be opened in any text editor. Notepad or Notepad++ are recommended.
* **Where do Object Definition File(s) go?**  
    
The ODFs can be placed anywhere within the game/mod's resource directories.
* **Object Definition File Format**  
    
ODF files are lists of Properties, one property per line. You can have gaps, but each property can only exist on one text line. For example:  
unitName = "Tank"  
Splitting lines like the following example will **NOT** work!  
unitName = "Tank"  
Characters on a line after // or ; are ignored, so use // or ; in front of any comments. Block Comments /\* ... \*/ are also supported.  
There are various types of Properties, with examples below:  
   * Integer/Long = 0  
   * Float/Double = 0.0  
   * Boolean = true // Anything starting with an 'F', 'N', or '0', is false, everything else is true.  
   * Character = "A" // String can be longer but only the first character is used.  
   * String = "Tank"  
   * Color = "255 255 255 255" // Red Green Blue Alpha  
   * Vector = "0.0 0.0 0.0" // X Y Z  
   * HexInteger = 0xFF // or without the 0x part.  
    
Invalid ODF Property lines are ignored, and errant characters on the end of ODF lines may cause unexpected results, so it's best not to make typos, and make proper use of // comments.  
    
The game looks for ODF Properties under specific Class based Headers, surrounded by brackets. For example:  
\[GameObjectClass\] classlabel = "wingman"  
The game will only look for specific ODF properties under the correct \[Header\] name. If an ODF property is not specified (or specified under the wrong Header), a default value is used instead. Most ODF properties have set defaults. This guide will display the default values. ODFs can contain multiple Headers, but only one of each Header/Property. If there are duplicates, only the last instance of an ODF Header/Property is read.
* **Basic info about Object Definition Files**  
    
There are four main types of ODF files:  
   * GameObject  
   * Weapon  
   * Ordnance  
   * Explosion  
    
Each type of object is a specific Class. An Entity's Class determines what kind of object it is, and thus how it behaves and is used by the game.  
    
The game has many individual Classes, some of which are based on other Classes. For instance: All buildings, persons and vehicles are GameObject Class. A Sabre tank is a Wingman Class, which is based upon HoverCraft Class. And HoverCraft Class is based upon GameObject Class. As such, the Class tree is: GameObject->HoverCraft->Wingman.  
    
Because they are based upon these root classes, all the ODF properties of a GameObject, apply to HoverCraft, and all HoverCraft properties apply to Wingman.  
    
Another example: The ISDF Service Bay is a SupplyDepot, The Class tree is: GameObject->Building>SupplyDepot. This means that all the properties of a Building work on a SupplyDepot.  
    
The game uses specific class label strings to identify the Class that an Entity belongs to. These Classes are exclusive and cannot be combined. These class labels are read by the following ODF properties:  
    
\[GameObjectClass\] classlabel = ""  
\[WeaponClass\] classlabel = ""  
\[OrdnanceClass\] classlabel = ""  
\[ExplosionClass\] classlabel = ""
  
ODFs can also contain Particle Renders. These can be located anywhere in any ODF. They still follow the same Header rules listed above. They are referenced by certain ODF properties as a string listing the filename, separated by a period, and then a Header name.  
See ODF Render Documentation Guide for more details.  
  
* **Advanced Settings**  
    
   * **Bit Masks**  
         
   **What is a Bit Mask?**  
   A bit mask is a binary set of numbers, converted into a decimal value. To get values, you can add together the numeric values of the options you want, OR use Windows Calculator.  
         
   To use Windows Calculator to get the numeric value of the binary setting you want, open the Calculator, and set mode to Programmer. Then select the BIN for Binary setting. Here, you type in the values you want, 0 for False, 1 for True. When typing in a Bit Mask, you want to start at the highest bit that is set to 1, and work your way down. The right most number is the first Bit. Once we set the Binary options we want, simply click DEC for Decimal mode to get the numeric value to put in the ODF parameter.  
         
   So, for instance, setting the 3rd bit in an 8 bit number would be: 00000100\. Since we don't need the leading 0's, it can be shortened to 100\. The DEC value for this is 4.  
   If we want the 7th bit, we put 01000000, The DEC value for this is 64.  
   If we want the 3rd and 7th bit, we put 01000100, or 1000100 for short. The DEC value for this is 68, which is 64 + 4\. BZ2's Bit Masks are usually 16 or 32 bits, and often only use the first few bits. Also some may have 1 bit less, technically, reserved.  
   * **ODF Inheritance**  
         
   **What is ODF Inheritance?**  
   ODF Inheritance is a method of making an Object Definition File that inherits most of the properties of another ODF, allowing you to only specify the settings you want different. ODF Inheritance has many useful applications in modding. It allows multiple variations of objects to exist, and be maintained easily. If you want to change something in the object, you can simply modify the root level ODF, and don't need to update all the variations that use ODF Inheritance.  
         
   So, if you have say, ivtank.odf, ivtankA.odf, ivtankB.odf, and ivtankC.odf, you could have ivtankA, ivtankB and ivtankC inherit off of ivtank. That way, if you wanted to adjust the maxHealth of the tank, you only have to modify the value once in ivtank.odf, and ivtank A, B, and C would all also use the new value. It is recommended that you use ODF Inheritance when making variations on Stock ODFs, so that if they are updated in a Patch, your mod(s) will be updated as well. It is also recommended if you are making a Mod that requires someone else's Mod as an Asset Package and make variants of ODFs included in that mod. That way, if they fix bugs or update their ODFs, you would also get the benefit of those updates without having to do anything.  
         
   **How to implement ODF Inheritance:**  
   ODF Inheritance is defined by setting the classlabel string to the file name of the ODF you want to inherit from. So, for the instance above, you would make ivtankA.odf have classlabel = "ivtank". You could then delete all the ODF properties that are the same as ivtank.odf's properties. It is recommended that you keep the Headers for ease of use/adding additional lines to the correct section. So, here is what your ivtankA.odf might look like:  
   \[GameObjectClass\] classLabel = "ivtank" \[CraftClass\] \[HoverCraftClass\]  
   It is possible to inherit an ODF from another inherited ODF, but it is not recommended. Also note that some ODF Properties do not support ODF Inheritance. This guide will note which properties are not inherited.

 Common Terms 

 When describing game behavior, I will use several common terms. Below is a list of these terms and what they mean:  
  
\* Is a wildcard character to represent any desired character. Often used when describing race specific ODFs, such as \*spilo, where \* would be the Race letter.  
  
AI: An object not being driven by the Player. This includes all units under a Player's control, as well as on Enemy teams.  
  
Team: The physical Team. Every player is on their own Team. Objects on the same Team appear Green on radar.  
  
Team Group: Team 1 and Team 2 in Multiplayer Strategy. This means Team 1 - 5 make up Team Group 1, and Team 6 - 10 make up Team Group 2.  
  
Ally: Allies, or Allied Teams means any team (often including itself) that is Allied. Allied Teams appear Blue on Radar.  
  
Enemy: Objects on a Team that is not the same as, or an Ally of their own team. Things that appear Red on Radar are considered Enemies.  
  
Perceived Team: This is the Team that AI units think an object is on. When you Snipe an enemy ship, and hop into it, you remain on their Perceived Team until you fire your weapons. While on their Perceived Team they will not consider you an Enemy.  
  
Deployed: When an object is in the Deployed state, such as a Turret, APC, Bomber, etc.  
  
Undeployed: When an object is in the Undeployed state, such as a Turret, APC, Bomber, etc.  
  
Race: A Race is a group of objects that are typically of the same faction, and link to various faction specific ODFs. A Race is identified by the first character of the ODF's name. Stock uses i for ISDF and f for Scion. Any character can be used, a - z, and even some special characters, however there are only 27 Races supported. This means only 1 Race is identified for all special characters.  
  
Target: The unit's currently selected Target for Attack or Special Action such as Service by a Service Truck.  
  
Building: An object derived from BuildingClass.   
  
Craft: An object derived from CraftClass.  
  
Vehicle: A Craft that is tagged as CLASS\_ID\_VEHICLE, used by Tracked Vehicles and Walkers, basically a heavy Craft.  
  
Hover: An object that has Hovercraft physics.  
  
Flier: An object that is similar to Hovercraft physics, but has a high Altitude and doesn't usually roll/tilt with Terrain. It is also considered isFlying by the AI when airborne.  
  
Tracked: An object that has Tracked physics.  
  
Walker: An object that has Walker like physics.  
  
Render: An ODF Render item. See ODF Render Documentation Guide for more info.  
  
If you see any terms that you are not sure what they mean, feel free to post in Comments and I'll add them to this list. 

 Classlabel List 

 Below is a list of all valid class label strings for the game, broken down by type.  
* GameObject:  
    
   * aircraft  
   * apc  
   * armory  
   * artifact  
   * artillery  
   * assaulthover  
   * assaulttank  
   * barracks  
   * boid  
   * bomberbay  
   * bomber  
   * i76building  
   * i76sign  
   * camerapod  
   * commbunker  
   * commtower  
   * commvehicle  
   * commvehicleH  
   * constructionrig  
   * constructionrigT  
   * craft  
   * deployable  
   * deploybuilding  
   * deploybuildingH  
   * deposit  
   * terrain  
   * computer  
   * Cnozzle  
   * extractor  
   * factory  
   * flag  
   * hover  
   * howitzer  
   * jammer  
   * kingofhill  
   * animal  
   * pointlight  
   * directionlight  
   * spotlight  
   * minelayer  
   * moneybag  
   * morphtank  
   * sensor  
   * beacon  
   * objectspawn  
   * person  
   * bush  
   * plant  
   * powered  
   * powerplant  
   * powerlung  
   * powerup  
   * recycler  
   * recyclervehicle  
   * recyclervehicleH  
   * sav  
   * scavenger  
   * scavengerH  
   * scrap  
   * servicepod  
   * repairkit  
   * ammopack  
   * service  
   * serviceH  
   * shieldtower  
   * silo  
   * spawnpnt  
   * supplydepot  
   * techcenter  
   * teleportal  
   * trackdeploy  
   * tracked  
   * tug  
   * turret  
   * turrettank  
   * iv\_walker  
   * fv\_walker  
   * wpnpower  
   * wingman  
   * daywrecker  
   * flare  
   * magnet  
   * mine  
   * proximity  
   * satchel  
   * seeker  
   * spraymine  
   * torpedo  
   * tripmine  
   * weaponmine
* Weapon:  
    
   * arccannon  
   * blink  
   * cannon  
   * chargegun  
   * damagefield  
   * dispenser  
   * forcefield  
   * imagelauncher  
   * imagerefract  
   * jetpack  
   * launcher  
   * machinegun  
   * magnetgun  
   * mortar  
   * multilauncher  
   * radardamper  
   * radarlauncher  
   * detonator  
   * salvo  
   * satchelpack  
   * shieldup  
   * specialitem  
   * targeting  
   * terrainexpose  
   * thermallauncher  
   * torpedolauncher  
   * weapon
* Ordnance:  
    
   * anchor  
   * beam  
   * bouncebomb  
   * bullet  
   * grenade  
   * imagemissile  
   * lasermissile  
   * laserpopper  
   * leader  
   * lockdown  
   * magnetshell  
   * missile  
   * ordnance  
   * popper  
   * pulse  
   * radarmissile  
   * radarpopper  
   * seismic  
   * snipershell  
   * spraybomb  
   * thermalmissile
* Explosion:  
    
   * explosion  
   * quakeblast

 AI Process Info 

**What is an AI Process?**

Most GameObject Class items use an AI Process. This determines their behavior when under AI control. This guide will provide the recommended AI Process for a GameObject, though any AI Process can be used on them. However, certain AI Processes will only work with a specific classlabel. Using the wrong AI Process will cause the game to Crash.  
  
AI State is a State listed in the Unit Info. It can be seen in the Pathing Editor when viewing Edit Task on an object's info in the top right. Some process description may reference these states.  
  
**AI State List:**

* GOTO // Go to a location.
* FOLLOW // Follow an object.
* ATTACK // Attack an object.
* WAIT // Wait...
* SLIDE // Can't hit target, move a bit to try to get a clean shot.
* STAND // Stay and defend current location.
* FLEE // Turn and run away.
* BLAST // Shoot at target.
* LEAD // Lead a group in a Goto or Attack command.
* CATCH // Catch up to a Follow target.
* STRAFE // Got hit by enemy fire, strafe to dodge.
* SCATTER // Spread out from current position some.
* JUMP // Can't hit target, Jump a little to try to get a clean shot.
  
**AI Process List:**

  
* AlternateAnimalProcess  
**Class Restrictions:** Craft  
    
This process is intended for use on animal class objects.This process wanders around and plays IDLE, WALK, RUN, CURIOUS, ATTACK, animations. It flees when shot, and attacks PersonClass objects.
* APCProcess  
**Class Restrictions:** APC  
    
This process plays SelectOtherMsg and SelectDropoffMsg. It goes to within 50m of a Target and Deploys to attack. When it's soldiers have all been killed, it Retreats to the nearest Refill point, normally Recycler, reloadClass, or Barracks.
* ArmoryProcess  
**Class Restrictions:** Armory  
    
Builds an object and sends it to a location. Supports CMD\_GET\_RELOAD and CMD\_GET\_REPAIR.
* AssaultTankProcess  
**Class Restrictions:** Craft  
    
Sits and Attacks if able to hit. Plays User2Msg if it can't hit it's Target.
* BoidProcess  
**Class Restrictions:** Craft  
    
Flies around in a semi localized area.
* BomberProcess  
**Class Restrictions:** Bomber  
    
Flies to a location and drops a bomb on the target.
* BuildingProcess  
**Class Restrictions:** Factory  
    
Does Factory building stuff.
* CameraPodProcess  
**Class Restrictions:** Powerup  
    
Aims the direction the user is facing when selected.
* CombatFriend
* CombatEnemy  
**Class Restrictions:** Craft  
    
Does general combat behavior.
* CommTowerProcess  
**Class Restrictions:** CommTower  
    
Interfaces with Terminal to enable Satellite View.
* RigFriend
* RigEnemy  
**Class Restrictions:** ConstructionRig  
    
Does ConstructionRig building, demolishing, upgrading, and adding Power lung behavior.
* RigTFriend
* RigTEnemy  
**Class Restrictions:** ConstructionRigT  
    
Does ConstructionRigT building, demolishing, upgrading, and adding Power lung behavior.
* DeployBuildingFriend
* DeployBuildingEnemy  
**Class Restrictions:** DeployBuilding  
    
Does deploying at a location.
* DeployBuildingHFriend
* DeployBuildingHEnemy  
**Class Restrictions:** DeployBuildingH  
    
Does deploying at a location.
* GechProcess  
**Class Restrictions:** Craft  
    
Does walker behavior, strafes to steer. If used on a Walker, it uses attackSpeed, otherwise it uses topSpeed.
* GunTowerFriend
* GunTowerEnemy  
**Class Restrictions:** TurretCraft  
    
Gun Tower attack behavior. Doesn't try to move.
* LandAnimalProcess  
**Class Restrictions:** LandCreature  
    
This process is intended for use on animal class objects.This process wanders around and plays IDLE, WALK, RUN, CURIOUS, ATTACK, animations. It flees when shot, and attacks PersonClass objects.
* MineLayerFriend
* MineLayerEnemy  
**Class Restrictions:** Minelayer  
    
Goes to a location, lays mines in a pattern.
* AttachOffensive  
**Class Restrictions:** Craft  
    
Does offensive craft stuff.
* PersonFriend
* PersonEnemy  
**Class Restrictions:** Person  
    
Gets in empty ships, or retreats to friendly Recycler, Factory, or Armory. Sits and attacks nearby Enemies if no friendly base to go to.
* SoldierProcess  
**Class Restrictions:** Craft  
    
Attacks a target, then waits by it's parent APC if present. If APC not present, retreats to friendly Recycler, Factory, or Armory. Sits and attacks nearby Enemies if no friendly base to go to.
* PowerUpProcess  
**Class Restrictions:** PowerUp  
    
Goes to a location of current command's Where when Flying.
* SAVFriend
* SAVEnemy  
**Class Restrictions:** Craft  
    
Deploys to move, Undeploys to attack. Prioritizes nearby Pilots, and apply "mulch" damage to them when it gets close enough.
* ScavProcess  
**Class Restrictions:** Scavenger  
    
Does collecting of scrap, returning if doDrop is true, and deploying on Pools.
* ScavHProcess  
**Class Restrictions:** ScavengerH  
    
Does collecting of scrap, returning if doDrop is true, and deploying on Pools.
* ServiceProcess  
**Class Restrictions:** ServiceTruck  
    
Services nearby units.
* ServiceHProcess  
**Class Restrictions:** ServiceTruckH  
    
Services nearby units.
* SupportProcess  
**Class Restrictions:** Craft  
    
Supports Lock On weapons.
* TorpedoProcess  
**Class Restrictions:** Craft  
    
Steers towards a Target.
* TugFriend
* TugEnemy  
**Class Restrictions:** Tug  
    
Can pickup/dropoff an object.  
_Note:_ It's Recycle order issues a Goto command instead of a Recycle command.
* TurretTankFriend
* TurretTankEnemy  
**Class Restrictions:** Craft  
    
Deploys to Attack. Undeploys to move. Sits and shoots when Deployed.
* UserProcess  
**Class Restrictions:** Craft  
    
Does Player related stuff. Not recommended for AI units.
* AttachWingman  
**Class Restrictions:** Craft  
    
Able to use Hunt command. Uses normal Attack behavior. Strafes when hit with enemy fire, and supports RetargetOnStrafe feature. Jumps when it can't hit it's target.
* TankFriend
* TankEnemy  
**Class Restrictions:** Craft  
    
Offensive Process that uses normal Attack behavior.
* ScoutFriend
* ScoutEnemy  
**Class Restrictions:** Craft  
    
Offensive Process that Objectifies 1 closest non-Objectified object within it's rangeScan. Only objectifies 1 object per Scout in a Group.
* SentryProcess  
**Class Restrictions:** Craft  
    
Same as ScoutFriend / ScoutEnemy but doesn't do the Target Objectification.
* RocketTankFriend
* RocketTankEnemy  
**Class Restrictions:** Craft  
    
Offensive Process that supports Lock On Missiles.
* MorphTankFriend
* MorphTankEnemy  
**Class Restrictions:** Craft  
    
Offensive process that Deploys to Attack isAssault targets.
* AirCraftFriend
* AirCraftEnemy  
**Class Restrictions:** Craft  
    
Deploys to Goto if it is an AirCraft. Supports AircraftAttackMustDeploy setting. Slows down when making an Attack and is in BLAST state.

 AI Task Info 

**What is an AI Task?**

An AI Task is a sub command that can be utilized by certain AI Processes. They can be specified with the following ODF settings:  

\[CraftClass\] attackTask = "" defendTask = "" waitTask = "" specialTask = "" subAttackTask = ""

  
**AI Task List:**

* AlternateAnimalTask  
alternative animal behavior
* APCAttack  
APC attack behavior, cannot be used by other units
* ArcherAttack  
Scion Archer attack behavior
* ArcherSubAttack  
same as ArcherAttack
* ArtlAttack  
deploys before attacking, aims high
* ArtlSubAttack  
same as ArtlAttack but starts in attack mode
* AssaultTankAttack  
attacks when can hit, stationary while attacking
* AttackTaskP  
general attack task
* BoidTask  
flocking behavior for birds
* BomberAttack  
Bomber attack behavior, cannot be used by other units
* RigBuild  
ConstructionRig build an object, cannot be used by other units
* UnBuild  
ConstructionRig unbuild the target object
* Upgrade  
ConstructionRig upgrade the target object, cannot be used by other units
* Power  
ConstructionRig behavior to restore power objects to power taps
* DefendTask  
defend the target object, wandering around it
* DropGoto  
DeployBuilding variant of GotoTask that slides into place, cannot be used by other units
* DropGotoH  
DeployBuildingH variant of GotoTask that slides into place, cannot be used by other units
* SimpleFollowTask  
follow the target object
* GechAttack  
Gech attack behavior, will scatter to avoid hitting friends
* GetServiceTask  
elects a leader unit to follow, will go get healed if damaged
* CashOutTask  
go back to the Recycler for recycling
* GotoTask  
go to a target location
* GoNear  
go near a target location
* GoPoints  
go along a path
* GoGet  
go to a target object, with intent to move on top of it
* GunTowerAttack  
GunTower attack, no support for movement
* HuntTask  
hunt around the map for enemy units
* LandAnimalTask  
LandCreature behavior behavior, cannot be used by other units
* LayMinesTask  
MineLayer mine-laying behavior, cannot be used by other units
* MortarBikeAttack  
MortarBike attack behavior (sit and fire, strafe when hit?)
* MortarBikeSubAttack  
same as MortarBikeAttack
* PatrolTask  
patrol using the strategic AI scheduler
* PersonRetreat  
pilot retreat back to recycler for recycling
* PersonAttack  
pilot and soldier attack behavior
* CollectTask  
normal Scavenger collect behavior, cannot be used by other units
* CollectHTask  
hover Scavenger collect behavior, cannot be used by other units
* RecycleTask  
normal Scavenger behavior, cannot be used by other units
* RecycleHTask  
hover Scavenger behavior, cannot be used by other units
* ScavGotoDrop  
normal Scavenger drop off scrap, cannot be used by other units
* ScavHGotoDrop  
hover Scavenger drop off scrap, cannot be used by other units
* ScavGotoScrap  
normal Scavenger pick up scrap, cannot be used by other units
* ScavHGotoScrap  
hover Scavenger pick up scrap, cannot be used by other units
* ScavGotoRepair  
normal Scavenger go to get repair
* ScavHGotoRepair  
hover Scavenger go to get repair
* ScavRetreatTask  
normal Scavenger retreat
* ScavHRetreatTask  
hover Scavenger retreat
* HarvestTask  
normal Scavenger harvest behavior, cannot be used by other units
* HarvestHTask  
hover Scavenger harvest behavior, cannot be used by other units
* RescueTask  
go to the target object, hop out when close enough
* SAVAttackPersonTask  
SAV attack person, mulch when close enough
* SAVAttackVehicleTask  
SAV attack vehicle, fly to move, descend to engage
* ServiceTask  
normal ServiceTruck behavior, cannot be used by other units
* ServiceHTask  
hover ServiceTruck behavior, cannot be used by other units
* SoldierAttack  
Soldier attack behavior, strafe when close or may hit friend
* SoldierRetreat  
soldier retreat back to base (target object) for recycling
* SupportSubAttack  
supports lock-on and charge weapons
* TugPickup  
Tug pick up object, cannot be used by other units
* TurretAttack  
Turret attack behavior
* TurretBlastAttack  
Turret blast attack behavior (simpler)
* TurretDefendTask  
Turret defend behavior, look for spot near target
* SitTask  
sit in place, look at enemy
* SitSpinTask  
sit in place, spin to reduce chance of being sniped
* SitAttack  
sit in place, attack when enemy is in range
* CircleTask  
drive in a circle
* CoastTask  
clear steering and movement controls to coast
* LookAtTask  
look at the target object
* WingmanBlastAttack  
start in attack mode, strafe and counterattack if damaged, jump if not able to hit, scatter to avoid hitting friends
* RocketTankAttack  
RocketTank attack behavior, stay close, circle-strafe target, counterattack when shot
* MorphTankAttack  
deploy for assault, undeploy for combat
* AimFireAttack  
aims at its target and fires, but doesn't move
* AirCraftAttack  
reduces throttle while making a "strafing run", and switches to goto mode when it can't hit its target.

 AI Command List 

 These are the various values for AI Commands:  
  
* 0 = CMD\_NONE
* 1 = CMD\_SELECT
* 2 = CMD\_STOP
* 3 = CMD\_GO
* 4 = CMD\_ATTACK
* 5 = CMD\_FOLLOW
* 6 = CMD\_FORMATION
* 7 = CMD\_PICKUP
* 8 = CMD\_DROPOFF
* 9 = CMD\_UNDEPLOY
* 10 = CMD\_DEPLOY
* 11 = CMD\_NO\_DEPLOY
* 12 = CMD\_GET\_REPAIR
* 13 = CMD\_GET\_RELOAD
* 14 = CMD\_GET\_WEAPON
* 15 = CMD\_GET\_CAMERA
* 16 = CMD\_GET\_BOMB
* 17 = CMD\_DEFEND
* 18 = CMD\_RESCUE
* 19 = CMD\_RECYCLE
* 20 = CMD\_SCAVENGE
* 21 = CMD\_HUNT
* 22 = CMD\_BUILD
* 23 = CMD\_PATROL
* 24 = CMD\_STAGE
* 25 = CMD\_SEND
* 26 = CMD\_GET\_IN
* 27 = CMD\_LAY\_MINES
* 28 = CMD\_LOOK\_AT
* 29 = CMD\_SERVICE
* 30 = CMD\_UPGRADE
* 31 = CMD\_DEMOLISH
* 32 = CMD\_POWER
* 33 = CMD\_BACK
* 34 = CMD\_DONE
* 35 = CMD\_CANCEL
* 36 = CMD\_SET\_GROUP
* 37 = CMD\_SET\_TEAM
* 38 = CMD\_SEND\_GROUP
* 39 = CMD\_TARGET
* 40 = CMD\_INSPECT
* 41 = CMD\_SWITCHTEAM
* 42 = CMD\_INTERFACE
* 43 = CMD\_LOGOFF
* 44 = CMD\_AUTOPILOT
* 45 = CMD\_MESSAGE
* 46 = CMD\_CLOSE
* 47 = CMD\_MORPH\_SETDEPLOYED // For morphtanks
* 48 = CMD\_MORPH\_SETUNDEPLOYED // For morphtanks
* 49 = CMD\_MORPH\_UNLOCK // For morphtanks
* 50 = CMD\_BAILOUT
* 51 = CMD\_BUILD\_ROTATE // Update building rotations by 90 degrees.
* 52 = CMD\_CMDPANEL\_SELECT
* 53 = CMD\_CMDPANEL\_DESELECT

 Configuration ODFs 

 There are several specific ODFs used to configure settings for various things. Below is a description of them:  
  
* **\*explosion.odf**  
    
**Description:**  
Explosion.odf is used to define the basic default Explosion Classes for various types of Game Objects. The \* is used for the Race letter if it exists, and falls back to explosion.odf if it does not. Below are the defaults in explosion.odf:  
    
**ODF Properties:**  
   * **\[Explosion\]**  
         
   classCraft = "xcarxpl"  
   Explosion Class used for Hovercraft and Aircraft.  
         
   classVehicle = "xvehxpl"  
   Explosion Class used for Tracked Vehicles and Walkers.  
         
   classTorpedo = "xpwrxpl"  
   Explosion Class used for Torpedoes.  
         
   classPowerup = "xpwrxpl"  
   Explosion Class used for Powerups.  
         
   classPerson = "xprsxpl"  
   Explosion Class used for Persons.  
         
   classAnimal = "xprsxpl"  
   Explosion Class used for Animals.  
         
   classStruct = "xbldxpl"  
   Explosion Class used for i76building / Terrain.  
         
   classBuilding = "xbldxpl"  
   Explosion Class used for PoweredBuildings.  
         
   classSign = "xsgnxpl"  
   Explosion Class used for i76sign and Mines.  
         
   classPlant = "xplnxpl"  
   Explosion Class used for Plants.  
         
   classChunk = "xsecxpl"  
   Explosion Class used for Chunks.  
         
   classCrash = "xvchxpl"  
   Explosion Class used for Vehicle Crash model.  
         
   classCollapse = "collapse"  
   Explosion Class used for Collapse effect of Buildings.
* **\*weapon.odf**  
    
**Description:**  
Weapon List configuration. \* is the Race letter. iweapon.odf is used if the Race's version doesn't exist. This lists all the Weapons, per Hard Point Category, that can appear in the Factory Panel customization list, if the requireCount# items are met.  
    
**ODF Properties:**  
For each of the following:  
   * \[Gun\]  
   * \[Cannon\]  
   * \[Rocket\]  
   * \[Mortar\]  
   * \[Special\]  
   * \[Shield\]  
   * \[Hand\]  
   * \[Pack\]  
   weaponCount = 0  
   How many weaponName items for each category.  
         
   weaponName1 ... weaponName# = ""  
   For each weaponCount, the ODF name for the PowerUp Class for the weapons in this category.
* **\*event.odf**  
    
**Description:**  
Event Sound file list. The \* is the Race letter. ievent.odf is used if the Race's version doesn't exist. This lists the sound files played upon various events occurring.  
    
**ODF Properties:**  
   * **\[BettyVoice\]**  
   EVENT\_SOUND\_1 = "abetty1.wav" // lost a generic unit EVENT\_SOUND\_2 = "abetty2.wav" // lost a defensive unit EVENT\_SOUND\_3 = "abetty3.wav" // lost an offensive unit EVENT\_SOUND\_4 = "abetty4.wav" // lost a scavenger EVENT\_SOUND\_5 = "abetty5.wav" // a unit is out of ammo EVENT\_SOUND\_6 = "abetty6.wav" // base is under attack EVENT\_SOUND\_7 = "abetty7.wav" // user vehicle is out of ammo EVENT\_SOUND\_8 = "abetty8.wav" // a unit is low on health EVENT\_SOUND\_9 = "abetty9.wav" // user vehicle is low on health EVENT\_SOUND\_10 = "abetty10.wav" // satellite view activated EVENT\_SOUND\_11 = "abetty11.wav" // no free power EVENT\_SOUND\_12 = "abetty12.wav" // lost a power plant EVENT\_SOUND\_13 = "abetty13.wav" // satellite view enabled EVENT\_SOUND\_14 = "abetty14.wav" // lost a generic building EVENT\_SOUND\_15 = "silence.wav" // satellite view deactivated EVENT\_SOUND\_16 = "silence.wav" // satellite view disabled
* **\*order.odf**  
    
**Description:**  
Order Panel Sounds. \* is the Race letter, iorder.odf is used if the Race's version doesn't exist. This lists the sound files played when you order a Human Player in Multiplayer to do something via the F slot Command Menu.  
    
**ODF Properties:**  
   * **\[OrderPanel\]**  
   MESSAGE\_SOUND\_1 = "team0106.wav" // follow me message MESSAGE\_SOUND\_2 = "team0107.wav" // attack target message MESSAGE\_SOUND\_3 = "team0112.wav" // defend target message MESSAGE\_SOUND\_4 = "team0101.wav" // need help message MESSAGE\_SOUND\_5 = "team0103.wav" // need service message MESSAGE\_SOUND\_6 = "team0115.wav" // need ship message MESSAGE\_SOUND\_7 = "" // get flag message MESSAGE\_SOUND\_8 = "" // defend flag message MESSAGE\_SOUND\_9 = "team0111.wav" // negative message MESSAGE\_SOUND\_10 = "team0110.wav" // acknowledge message MESSAGE\_SOUND\_11 = "ivscout03.wav" // protecting message
* **shieldeffect.odf**  
    
**Description:**  
This configures the ShieldUpgrade Effect render used when Ordnance impacts an Object with a ShieldUpgrade Weapon equipped.  
    
**ODF Properties:**  
   * **\[ShieldEffect\]**  
         
   noFirstPerson = true  
   If this is true, the Shield Effect is not rendered when in Cockpit View of the object being hit.  
         
   latitudeBands = 8  
   Latitude Bands along each Hemisphere of the Sphere.  
         
   longitudeSegments = 16  
   Longitude Segments of the Sphere.
* **Taunts.odf**  
    
**Description:**  
The Taunts ODF is specified in the map's TRN file, defaulting to Taunts.odf if not specified.  
It lists Category names to be loaded from the Asset system's localization folder. These have the category name appended to them with an underscore in between.  
For instance: Category0 = "\_start" by default, looks for Taunts\_start.otf in the Localization folder for the specified language. Each new line of the .otf is treated as a separate Taunt.  
    
**ODF Properties:**  
   * TauntCategories  
         
   Category0 ... Category15 = ""  
   The name to append to the Taunt ODF for each Category. Looks for .TRN's \[DLL\]TauntODFFile\_category.otf.

 EntityClass 

 All things in the world are Entities, but Entity itself is not a valid class label. However, there are some ODF properties that are listed for Entities in general.  
  
* **\[EntityClass\]**  
AllowHQShadows = true  
This value specifies if the object can cast a High quality Shadow. If set to false, only the Low (sprite) based shadow will render.  
    
Almost all classes support two Level Of Detail (LOD) models. LOD1 and LOD2 models are toggled when Object Detail setting in Graphics Options is set to Medium or Low, and based on either the user's Distance from the object, or the object's relative size on screen. Generally, LOD1 is used first at mid range, and LOD2 is used last at furthest range. LOD models do not support any Animations.
* **\[LOD1\]**  
dontShiftLOD = false  
This value, if set to true, will disable shifting of LOD values between LOD1 and LOD2, meaning the object will only use LOD1.  
    
geometryName = ""  
This specifies the model name of the LOD1 entry. Model filename with extension, either XSI or FBX supported. Example: "ivtankL1.xsi"  
    
radius = 2.0f  
Radius threshold of screen size, determining how small the object must be on screen before considering switching to this LOD model.  
    
distance = 1000.0f  
The distance from the object must be from the Player for it to consider using this LOD model.
* **\[LOD2\]**  
Same as the values listed above, used for 2nd LOD level.  
dontShiftLOD = false  
geometryName = ""  
radius = 1.0f  
distance = 2000.0f

 GameObjectClass P1: General Settings 

 All objects that are derived from GameObject Class have the following properties.  
  
**ODF Properties:**  
* **\[GameObjectClass\]**  
    
baseName = ""  
baseName is used to override an object's base type identification. This is a quick way to set an object's F-Group unit Icon, Info key card, and Status display image name. By default, baseName will default to the file name of the ODF. For instance: ivmytank.odf will by default look for ivmytank.inf for it's Info card, icon\_ivmytank.dds for it's unit icon, and wire\_ivmytank.dds for it's status display image. Setting baseName = "ivtank" will make it try to use ivtank.inf, icon\_ivtank.dds, and wire\_ivtank.dds respectively. Though these can be overridden individually per ODF, this provides a quick and easy way to specify this object's base type.  
    
unitName = ""  
This object's Name. This is what is displayed over the object's head, in the build menu, and Factory terminal panel. This string is also passed through the Translation table for localization.  
    
unitIcon = "icon\_baseName.tga"  
This is the icon image that appears in the unit's F group. Default is the gCfg (baseName).  
_Note:_ This setting is not ODF Inherited.  
    
unitStatus = "wire\_baseName.tga"  
This is the status image that appears above the weapons panel. Default is the gCfg (baseName).  
_Note:_ This setting is not ODF Inherited.  
    
infoName = "baseName.inf"  
This is the Info key card that comes up when you press the Interact key while looking at an object. If not specified, it looks for the ODF name, with .inf extension. If that is not found, it looks for baseName with .inf extension.  
    
ignoreMissingInf = false  
If this is true, it will squelch the warnings about missing .inf files from this odf.  
_Note:_ This is not ODF Inherited.  
    
canInteract = true  
Determines if this object can be interacted with. Controls info card key interaction, point-space reticle interaction, being able to see health/ammo when looking at the object, etc.  
_Note:_ Default is false for: Boid, Terrain, Computer, CNozzle, KingofHill, ObjectSpawn, Person, Plant, Bush, Scrap.  
    
nation = race letter determined by the first character of the object's ODF name.  
This setting controls the default setting for if Factory/Constructor Chrome effect is used, and which type of Walker hierarchy is used. Both of these can be specified in their respective ODF Class sections, however.  
_Note:_ This setting is old, and only supports i and f.  
    
ownsTerrain = false  
If this object owns the terrain it is on. This registers this object's collision with the terrain cluster's collision map.  
_Note:_ Default is true for Buildings with terrain\_\_h as their root mesh, or tunnelCount > 0.  
    
isTerrain = false  
Sets if this object is a terrain replacing object. If true,  
_Note:_ Default is true for Class: Terrain, Computer, CNozzle, and Buildings with terrain\_\_h as the root model piece.  
    
needPilot = false  
If this object needs a pilot inside of it.  
_Note:_ Default is true for Craft. Only valid for Craft and Vehicle types. (Gun Towers are a Craft)  
    
playerOnly = false  
If this is true, only the Player can hop into this object.  
    
canDetect = true  
If true, this object can be seen on Radar.  
_Note:_ False for Class: Boid, Terrain, Computer, CNozzle, KingofHill, ObjectSpawn, Person, Plant, Bush,  
    
canSnipe = false  
If true, this object can be sniped.  
_Note:_ Defaults to true for Class: Craft, except for: AssaultTank, AssaultHover, SAV, Tracked, Turret, Walker.  
    
canCollide = false  
Controls if this object can be collided with.  
_Note:_ Defaults to true for Class: Craft, Flag, Mine, Powerup, Torpedo.  
    
boxCollide = true  
This changes the collision type to Box type, similar to Battlezone 1's vehicle collisions. It uses a rectangle box that uses the extents of each axis on the model to determine length,width, and height.  
_Note:_ Default is false for Class: Craft, Person, Powerup, Torpedo.  
    
isAssault = false  
This flags if this object should be considered for "Assault mode" when it is attacked. Certain AI Processes will use weapon hard points that are set as Assault, and morphtanks will Morph to Assault mode to attack objects with isAssault = true.  
_Note:_ Default is true for Class: Building, Tracked, Turret, Walker.  
    
isSingle = false  
If this is true, you can only Build one of this item on your team.  
_Note:_ Default is true for Class: Armory, Baracks, BomberBay, Bomber, CommTower, Factory, Recycler, RecyclerVehicle, RecyclerVehicleH, SupplyDepot.  
    
isGrouped = false  
If this is true, this object is placed in an F-Group slot.  
_Note:_ Default is true for Class: Craft, except for: Person, Turret.  
    
needGroup = false  
If this is true, this object needs a valid available F-Group to be able to Build it.  
_Note:_ Defaults true for Class: BomberBay, and Craft, except for: Person, Turret.  
    
isLimited = false  
If this object counts against the MP Unit Limit.  
_Note:_ Default is true for Class: Craft, except for: Person.  
    
needLimit = false  
If this object needs a free MP Unit Limit slot to Build it.  
_Note:_ Default is true for Class: Craft, except for: Person.  
    
limitClass1 ... limitClass32 = ""  
This is the provideName that this object limits against for the Team.  
    
limitClass1Count ... limitClass32Count = 0  
This is how many of the corresponding limitClass# are allowed on the Team.  
    
limitClass1Text ... limitClass32Text = ""  
This is the Text displayed when you try to Build an item that has reached it's LimitCount.  
    
teamLimitClass1 ... teamLimitClass32 = ""  
This is the provideName that this object limits against for the entire Team Group.  
    
teamLimitClass1Count ... teamLimitClass32Count = 0  
This is how many of the corresponding teamLimitClass# are allowed on the Team Group.  
    
teamLimitClass1Text ... teamLimitClass32Text = ""  
This is the Text displayed when you try to Build an item that has reached it's teamLimitCount.  
    
isStealth = false  
Determines if this object can be seen on Radar and Targeted with out line of sight.  
    
CanSelect = true  
If this object can be Selected via F-Slot or point-space Reticle interaction.  
_Note:_ Default is false for Class: CommBunker.  
    
NoShadow = false  
If this is true, the object doesn't cast a shadow.  
    
ClipDepth = true  
If false, this object doesn't perform depth clipping.  
    
Permanent = false  
If this is true, when the player who owns this object leaves an MP game, this object sticks around instead of exploding.  
    
AllowSeismic = true  
If this is false, this object is not moved by Class: Seismic.  
    
Tuggable = -1  
If this object can be picked up by a Tug.  
Valid values are: -1 = default behavior, 0 = never tuggable, 1 = always tuggable  
_Note:_ Default is 0 for Class: Bomber, also Buildings, Tugs, and Turrets are never tuggable.  
    
ScanTeamLimit = 0  
Determines which team(s) can see this object on Radar. Also prevents AI from targeting it if they can't see it.  
Valid values are: 0 = all teams, 1 = same team only, 2 = allies only, 3 = never visible on Radar.  
_Note:_ Default is 3 for Class: SpawnBuoy.  
    
PilotConfig = ""  
If specified, this is the ODF of the pilot this unit starts with. Default is the race's \*spilo.  
    
alwaysClip = false  
Determines if this object should always clip?

 GameObjectClass P2: General Settings 2 

* **\[GameObjectClass\]**  
    
SingletonGroup = false  
If true: GroupPanel (F Slots) can only select this group by itself, no others.  
    
IdenticalGroup = false  
If true: GroupPanel (F Slots) can only select this group with identical groups.  
_Note:_ Bomber class defaults to true.  
    
DAMAGE\_SCALE = 0.05f  
This is a modifier of how much velocity is translated into damage upon collision.  
Calculation: _((Damage\_Scale \* massDifference \* relativeVelocity) - 10) \* armorRatio \* shieldRatio_  
armorRatio: N = 1.0, L = 0.75, H = 0.5  
shieldRatio: N, A = 1.0, S = 0.75, D = 0.5.  
    
Mass = -1.0f  
This is the amount of mass an object has. If <= 0, it uses the default of Sphere(Width \* Height \* Breadth) \* 800.0f. You can open an ascii-saved .sav or .bzn file with notepad to determine what existing objects have by default.  
    
allowTLI = true  
If true, allows Target Lead Indicator (TLI) on this object, assuming Server and Player preferences allow it.  
    
allowMDMCollisionDetonation = -1  
This is a setting for if BounceBombs (MDM Mortar) explode upon contact with this object.  
Valid values are: -1 = auto (== hit non-building), 0 = never, 1 = always. \[Applies to all bouncebombs.\]  
    
enableServiceTruckPull = -1  
Valid values are: -1 = auto, 0 = never, 1 = always pull this object when Service Truck serviced if moveable. Auto is classic behavior that this must be moveable & tuggable.  
    
serviceTruckAutoHeal = -1  
This is a setting that controls if a Service Truck will automatically heal this object type.  
Valid values are: -1 = auto, 0 = never, 1 = always heal this.  
_Note:_ Setting this to 1 will cause Service Trucks to always heal this object, even if it does not meet their category requirements under \[ServiceTruck\]/\[ServiceTruckH\].  
    
Lifespan = -1.0f  
If this is >= 0, this is how many seconds, from creation, until the object is destroyed.  
    
CanAcceptPowerups = true  
If this is true, it can accept powerups. False if not.  
    
AcceptPowerupMask = 127  
Bit Mask for what kind of Powerups this object can accept. Bitmask values:  
   * 1 = NONE  
   * 2 = CAMERAPOD  
   * 4 = DAYWRECKER  
   * 8 = FLAGOBJECT  
   * 16 = MONEY  
   * 32 = SERVICE  
   * 64 = WEAPON  
    
DeployedPowerupMask = 127  
Bit Mask for what kind of Powerups can be accepted while Deployed. Refer to list above for values.  
    
PowerupRaceMask = 134217727  
Bit Mask for which race's Powerups this object can accept. 27 total Bits, from a ... z, plus one for Powerups that don't start with a letter.  
    
DeployedPowerupRaceMask = 134217727  
Bit Mask for which race's Powerups this object can accept while Deployed. See above for values.  
    
MaxChromeDistance = 0.0f  
If this is > 0, it will disable the Chrome effect of morphing/building when this object is that distance from the Camera.  
    
ExplosionEnergy = 1000.0f  
How much Energy is passed into the Explosion.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
xplChunk = ""  
Explosion Class ODF for when a Chunk hits the ground. Default is the race's \*explosion.odf's value for xplChunk.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
xplCrash = ""  
Explosion Class ODF for when the vehicle Crash model hits the ground. Default is the race's \*explosion.odf's value for xplCrash.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
ExplodeSound = ""  
The sound when this object Explodes.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
LeaveExplodeScorch = true  
If false, won't darken the ground when it explodes.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
LightsOnlyWhenPiloted = false  
If true, lights will be disabled when the craft has no Pilot, and toggle back on when a Pilot hops into it.  
    
AlwaysShowAmmo = false  
If true, it will display the Ammo bar under Health, even if the object is an Enemy.  
    
SmartIsAirUnitCheck = true  
If true, then it only considers Artillary, Bomber, APC, and SAV as "Flying". If false, it uses the isFlying flag which when the craft is greater than 2 \* setAltitude from the ground.  
    
AllowFactoryCustomizations = true  
If false, this object can't be modified in the Factory Panel.  
    
StayWithOwner = false  
If this is true, objects that perform Construction in a TeamPlay game such as Class: Scavenger, ScavengerH, DeployBuilding, DeployBuildingH, ConstructionRig, will build the object on the same Team as the current owner, instead of it swapping to the Commander's Team.  
    
AllowUndergroundSpawn = false  
If this is false, objects with models that extend below terrain will be forced up if they are spawned via Script. If true, will spawn with the model's root position at terrain height. Default is true for Class: Building.  
    
UseCollisionMeshForPathing = -1  
If this is 0, it won't use collisionMesh for pathing, if it is 1, it will use the CollisionMesh for pathing. Default is -1, which is true for isTerrain objects.  
    
FactoryCustomizationMask = 2147483647  
Bit Mask for which Weapon Slots are editable in the Factory Panel. Valid values are:  
   * 1 = Weapon Slot 1  
   * 2 = Weapon Slot 2  
   * 4 = Weapon Slot 3  
   * 8 = Weapon Slot 4  
    
PowerupSlotAcceptMask = 2147483647  
Bit Mask for which Weapon Slots can accept Powerups. Valid values are:  
   * 1 = Weapon Slot 1  
   * 2 = Weapon Slot 2  
   * 4 = Weapon Slot 3  
   * 8 = Weapon Slot 4  
    
AlignTerrainReplaceType = 0  
Controls how the object snaps to terrain squares. Valid values are 0 - 5.  
Some experimentation required.  
    
DeployOnBuild = -1  
Setting for if this object sets a Deploy state upon initial creation. 0 is force Undeploy. 1 is force Deploy.  
_Note:_ Bombers and APCs ignore this setting.  
    
VehicleSearchFilter = 0  
Filter for what types of targets this object attacks. Valid values are:  
   * 0 = Vehicle  
   * 1 = Person  
   * 2 = Vehicle+Person+Animal  
   * 3 = Plant  
   * 4 = Building  
_Note:_ Do not laugh at the plants, they will kill you.  
    
TerrainBlendRadius = 0  
Setting for how many vertices around the boarder of a Building get blended to it's height. Larger values means smoother blending. Default is 3 for Class: Building.  
    
MaxPostExplosionVelocity = -1  
Maximum velocity able to be added to an object from an Explosion. Default is 250% velocForward for Class: Tracked, and 50.0m/s for everything else. This is used with DamageIfVelocityClamped to calculate Damage from excess Velocity.  
    
DamageIfVelocityClamped = 0.05  
Amount of health lost if Velocity is clamped by maxPostExplosionVelocity.  
    
GameObjectClassServiceMask = 0  
Bit Mask for use with \[SupplyDepotClass\]::SupplyDepotClassServiceProvides to allow service.  
    
GameObjectClassServiceMatch = 0  
Bit Mask for use with GameObjectClassServiceMask and \[SupplyDepotClass\]::SupplyDepotClassServiceProvides to allow service.  
    
GameObjectClassServiceProvides = 0  
Bit Mask for what use with \[SupplyDepotClass\]::SupplyDepotClassServiceMask and \[SupplyDepotClass\]::SupplyDepotClassServiceMatch to allow service.  
    
GameObjectClassPowerUpMask = 0  
Bit Mask for use with \[PowerupClass\]::PowerupClassProvides to allow pickup.  
    
GameObjectClassPowerUpMatch = 0  
Bit Mask for use with PowerupClassMask and \[PowerupClass\]::PowerupClassProvides to allow pickup.  
    
GameObjectClassPowerUpProvides = 0  
Bit Mask for what use with \[PowerupClass\]::PowerupClassMask and \[PowerupClass\]::PowerupClassMatch to allow pickup.

 GameObjectClass P3: Combat Settings 

 GameObjectClass settings Part 2\. This section focuses on Combat related settings, to do with Health/Ammo/Weapons.   
  
* **\[GameObjectClass\]**  
    
maxHealth = 0  
This object's maximum Health. 0 is indestructible.  
    
addHealth = 0  
How much health this object gains over a 1 second time period.  
    
aiAddHealth = addHealth  
How much health this object gains over a 1 second time period, when piloted by an AI, not a User.  
    
CondAddHealthMinRatio1 ... CondAddHealthMinRatio8 = -1  
Conditional AddHealth minimum Health Ratio that this object must be for the conditional to pass.  
    
CondAddHealthMaxRatio1 ... CondAddHealthMaxRatio8 = -1  
Conditional AddHealth maximum Health Ratio that this object must be for the conditional to pass.  
    
CondAddHealthValue1 ... CondAddHealthValue8 = 0  
Amount of AddHealth done by this conditional.  
    
CondAddHealthFlags1 ... CondAddHealthFlags8 = 2147483647  
Bit Mask for which Flags are used to enable this AddHealth. Values listed below:  
   * Bit 0 (value = 1)  
    Val=1: condition done when craft is empty.  
    Val=0: skip if craft is empty  
   * Bit 1 (value = 2)  
    Val=1: condition done when craft is occupied by AI.  
    Val=0: skip if craft is not occupied by AI  
   * Bit 2 (value = 4)  
    Val=1: condition done when craft is occupied by human (local/remote player).  
    Val=0: skip if craft is not occupied by human (local/remote player)  
   * Bit 3 (value = 8)  
    Val=1: condition done when craft is undeployed.  
    Val=0: skip if craft is deployed  
    \- bit flag is skipped if not a craft  
   * Bit 4 (value = 16)  
    Val=1: condition done when craft is deployed.  
    Val=0: skip if craft is undeployed  
    \- bit flag is skipped if not a craft  
   * Bit 5 (value = 32)  
    Val=1: condition done when object is unpowered.  
    Val=0: skip if object is powered  
   * Bit 6 (value = 64)  
    Val=1: condition done when object is powered.  
    Val=0: skip if object is unpowered  
   * Bit 7 (value = 128)  
    Val=1: condition done when object is not locked down.  
    Val=0: skip if object is locked down  
   * Bit 8 (value = 256)  
    Val=1: condition done when object is locked down.  
    Val=0: skip if object is not locked down  
   * Bit 9 (value = 512)  
    Val=1: condition done when movement inputs are pressed.  
    Val=0: skip if movement inputs not pressed.  
   * Bit 10 (value = 1024)  
    Val=1: condition done when movement inputs are not pressed.  
    Val=0: skip if movement inputs are pressed.  
    
DoBettyHealth = true  
If true, does the Betty "Low Health" warning when the user's Health is below 25%.  
    
maxAmmo = 0  
This object's maximum Ammo. 0 is NOT infinite.  
    
addAmmo = 0  
How much ammo this object gains over a 1 second time period.  
    
aiAddAmmo = addAmmo  
How much ammo this object gains over a 1 second time period, when piloted by an AI, not a User.  
    
DoBettyAmmo = true  
If true, does the Betty "Low Ammo" warnings when the user's Ammo (or available shots in the currently selected Weapon) reaches 0.  
    
aiName = ""  
AI Process name. This is the brains of the unit, and controls it's behavior. aiName is used for Player controlled craft, or if no aiName2 is specified.  
This must be one of the specified AI Process strings, and must be a valid type for the Class of object. Valid AI Names are listed in the AI Processes section.  
_Note:_ Specifying an incorrect AI Name will lead to crashes.  
    
aiName2 = ""  
AI Process name for Non-Player controlled objects, if specified.  
This must be one of the specified AI Process strings, and must be a valid type for the Class of object. Valid AI Names are listed in the AI Processes section.  
_Note:_ Specifying an incorrect AI Name will lead to crashes.  
    
collisionRadius = Bounding Sphere \* 0.75f  
This is the object's collisionRadius size, used for AI avoidance and path planning.  
    
CanBeIdleVictim = true  
If true, then this object can be the target of an AIP Plan's idle units dispatch.  
    
DoBettyAttack = true  
If true, will do the radar beep and warning Betty sounds when this object is damaged.  
    
Weapon Settings  
    
weaponHard1 .... weaponHard5 = ""  
This is the hard point name in the Model. The name must start with one of the following, and it must match exactly with a piece in the model. These traditionally have "HP\_" in front of them, to make them Hidden Parts, but that isn't required. The following are valid Hardpoint names, with or without HP\_ in front of them:  
   * "GUN"  
   * "CANN"  
   * "MORT"  
   * "ROCK"  
   * "SPEC"  
   * "SHIE"  
   * "HAND"  
   * "PACK"  
    
visualHard1 ... visualHard5 = ""  
This is a visual hard point for this weapon. This is the location a visual mesh for the weapon's GeometryName is attached. See Pilot weapons for an example of this.  
    
recoilName1 ... recoilName5 = ""  
The model piece name that Recoils when this weapon is fired.  
    
recoilDist1 ... recoilDist5 = -0.6f  
How far forward/backwards the corresponding recoilName piece moves.  
    
weaponAssault1 ... weaponAssault5  
Flag for if this weapon is an Assault hard point or not. Only matching weapon types will be picked up by this Hard point, and this hard point will be preferred against isAssault targets by some AI Processes.  
    
weaponName1 ... weaponName5 = ""  
The ODF file name for the Weapon Class for this hard point.  
_Note:_ Must be a valid Weapon Class of ODF.  
    
weaponGroup1 ... weaponGroup5 = -1  
Sets this weapon into a specific Group. Default is the normal behavior: Group same Hardpoint Type and Assault settings. Valid values are 0 - 4.  
    
weaponMask = "11111"  
Binary bit mask for which weapons, out of the 5 weapon hard points, that the AI should try to use. 0 = don't use, 1 = use.  
_Note:_ The order goes from right to left, for hard point 1 - 5\. So effectively "54321".  
    
    
imageSignature = 1.0f  
This is the object's Image signature strength. It controls how fast Image Launchers can lock onto it.  
    
radarSignature = 1.0f  
This is the object's Radar signature strength. It controls how fast Radar and Torpedo Launchers can lock onto it.  
    
heatSignature = 1.0f  
This is the object's Heat signature strength. It controls how fast Thermal Launchers can lock onto it, and how strongly Thermal Missiles are attracted to it.  
    
armorClass = "N"  
This object's Armor type. Valid values are:  
   * N = None  
   * L = Light  
   * H = Heavy  
    
shieldClass = "N"  
This object's Shield type. Valid values are:  
   * N = None  
   * S = Stasis  
   * D = Deflection  
   * A = Absorption  
    
hitType = "B"  
What kind of explosion is used when an ordnance hits this object. Valid values are:  
   * N = None  
   * G = Ground  
   * P = Person  
   * V = Vehicle  
   * B = Building  
_Note:_ Default is Vehicle for Class: Craft. Default is Person for Class: LandCreature and Person. Default is Ground for Class: Terrain, Computer, CNozzle if they are isTerrain.  
    
explosionName = ""  
If specified, this is the explosion ODF to use. For iexample: explosionName = "xbldxpl".  
Default if not specified is chosen from the race's explosion.odf based on this object's type.  
    
damageEffect1 ... damageEffect4 = "dmgvhcl1" ... "dmgvhcl4"  
These are the Renders for the Damage Smoke. Below is a list of when they are used:  
   * damageEffect1 starts when the object is below 50% health.  
   * damageEffect2 starts when the object is below 25% health.  
   * damageEffect3 starts when the object is below 12.5% health.  
   * damageEffect4 is used on the Crash model generated when the object explodes.  
Damage Smoke is read here, and used on VehicleCrash, though I'm fairly sure only Craft can use it, and it uses the values found under \[CraftClass\] instead.

 GameObjectClass P4: Build Settings 

* **\[GameObjectClass\]**  
    
scrapCost = 2147483647  
This is the amount of scrap this object costs to build, when built from a Recycler, Factory, Armory, or Constructor.  
    
scrapValue = 0  
This is the amount of scrap the object drops when destroyed.  
    
scrapReturn = scrapValue  
This is the amount of scrap the object returns when it is Recycled, or it's construction is Cancelled.  
    
powerCost = 0  
This is the amount of Power the the object consumes while it exists.  
    
buildTime = 5.0f  
This is the amount of time, in seconds, it takes to build this object.  
    
customCost = scrapCost \* 6 / 5  
This is the amount of scrap the object cost to build, if it's weapons have been modified through the user interface terminal in a Recycler/Factory.  
    
customTime = buildTime \* 1.2f  
This is the amount of time, in seconds, it takes to build this object, if it's weapons have been modified through the user interface terminal in a Recycler/Factory.  
    
CanDropScrap = true  
If false, this object doesn't drop scrap when it dies.  
_Note:_ Default is false for Class: Person  
    
ScrapClass1 ... ScrapClass3 = ""  
This is the ODF name of the scrap pieces dropped by this object. If not specified, it defaults to the race's \*pscr1 ... \*pscr3, respectively.  
    
buildRequire = "N"  
This specifies the requirement for building adjacency. It must be built on Terrain that matches this type. Valid values are:  
   * "N" = None: This can be built anywhere.  
   * "F" = Flat: Must be built on flat terrain. (Comm Bunker)  
   * "A" = Adjacent: Must be built Adjacent to a building. (Gun Tower)  
   * "B" = Base: Must be built Adjacent to a Base building. (Power Plant)  
_Note:_ Default is Flat for Class: Building, CommBunker, MotionSensor, Recycler. Default is Base for Class: CommTower, PoweredBuilding, PowerPlant, Silo. Default is Adjacent for Class: Teleportal, Turret.  
    
buildSupport = "N"  
This specifies what kind of building adjacency this object supports nearby. Valid values are:  
   * "N" = None: No support added.  
   * "F" = Flat: Supports Flat? ??  
   * "A" = Adjacent: Supports Adjacent Requirement (Comm Bunker)  
   * "B" = Base: Supports Base adjacency (Most ISDF Buildings)  
   * "X" = None: Nothing can be built next to it.  
_Note:_ Default is Adjacent for Class: CommBunker, MotionSensor, Teleportal, Turret. Default is Base for Class: CommTower, PoweredBuilding, PowerPlant, Recycler.  
    
ClearBuildZone = -1  
This setting controls if this object is pushed out of a building's build zone while it's under construction. For example: If you order a Constructor to build a building on top of a Turret, the turret gets pushed out of the building area.  
Valid values are: -1 = auto, 0 = never, 1 = always. If 0/1, overrides collide-able setting.  
    
CategoryTypeOverride = -1  
This is the object's Category Type. Default is based on the type of object it is. Setting this to >= 0 overrides that. Valid values are:  
   * 0 = TEAM\_SLOT\_PLAYER  
   _Note:_ base buildings. Items 1-9 can have dropmenus associated with them.  
   * 1 = TEAM\_SLOT\_RECYCLER  
   * 2 = TEAM\_SLOT\_FACTORY  
   * 3 = TEAM\_SLOT\_ARMORY  
   * 4 = TEAM\_SLOT\_PRODUCER4  
   * 5 = TEAM\_SLOT\_PRODUCER5  
   * 6 = TEAM\_SLOT\_PRODUCER6  
   * 7 = TEAM\_SLOT\_PRODUCER7  
   * 8 = TEAM\_SLOT\_PRODUCER8  
   * 9 = TEAM\_SLOT\_PRODUCER9  
   * 10 = TEAM\_SLOT\_TRAINING  
   * 11 = TEAM\_SLOT\_BOMBERBAY  
   * 12 = TEAM\_SLOT\_SERVICE  
   * 13 = TEAM\_SLOT\_TECHCENTER  
   * 14 = TEAM\_SLOT\_COMMTOWER  
   _Note:_ items above here are automatically limited to 1 item per team with that CategoryType  
   * 15 = TEAM\_SLOT\_POWER  
   * 16 = TEAM\_SLOT\_COMM  
   * 17 = TEAM\_SLOT\_EXTRACTOR  
   * 18 = TEAM\_SLOT\_JAMMER  
   * 19 = TEAM\_SLOT\_SENSOR  
   * 20 = TEAM\_SLOT\_GUNTOWER  
   * 21 = TEAM\_SLOT\_SHIELDTOWER  
   _Note:_ Above items are base buildings  
   * 22 = TEAM\_SLOT\_OFFENSE  
   * 23 = TEAM\_SLOT\_DEFENSE  
   * 24 = TEAM\_SLOT\_UTILITY  
   * 25 = TEAM\_SLOT\_SCAVENGER  
   * 26 = TEAM\_SLOT\_CONSTRUCT  
   * 27 = TEAM\_SLOT\_BOMBER  
    
requireCount = 0  
The number of requireName# entries it uses. Max is 16.  
    
requireName1 ... requireName16 = ""  
This is a valid odf or provideName that this object requires to exist on the same team before it can be Built.  
    
requireText1 ... requireText16 = ""  
This is the Text that is displayed when you try to Build an item missing the corresponding requireName entry.  
    
provideCount = 0  
The number of entries this object Provides for Requirements. Max is 32.  
_Note:_ If this is <=0, the object still provides it's ODF name.  
    
provideName1 ... provideName32  
This is the Name that this object provides for Requirements.  
    
upgradeName = ""  
The ODF name that this object can be Upgraded to, if specified.  
    
    
FactoryWeaponConfig = ""  
This is a setting for what weapon.odf list is used for this unit when modifying it in a Factory Panel. If not specified, the default is the race's weapon.odf list.  
_Note:\[i/\] Must end in .odf, e.g. "iweapon.odf"\[/list\]_

 GameObjectClass P5: Model Settings 

* **\[GameObjectClass\]**  
    
geometryName = ""  
This object's Model file name. Can be .XSI or .FBX.  
    
geometryScale = 1.0f  
This model's Scale.  
_Note:_ Skinned meshes do not scale well.  
    
mrmFactor = 0  
Depreciated, old method of LOD for Skinned meshes.  
    
animCount = 0  
Number of Animations to load for this object.  
    
animName1 ... animName# = ""  
Name for Animation. Some classes play animations on their own. See list of supported AnimNames for each Class.  
    
animFile1 ... animFile# = ""  
Model file name for the specified Animation. Can be .XSI or .FBX  
_Note:_ You can use .XSI files with a .FBX geometryName, as long as the hierarchy matches.  
    
cockpitName = ""  
Model file name for the Cockpit model. Can be .XSI or .FBX  
    
cockpitScale = 1.0  
Scale for Cockpit Model.  
    
animCountCockpit = 0  
Number of Animations to load for Cockpit model.  
    
animNameCockpit1 ... animNameCockpit# = ""  
Name for Animation. See list of supported AnimNames for each Class.  
    
animFileCockpit1 ... animFileCockpit# = ""  
Model file name for the specified Animation. Can be .XSI or .FBX  
_Note:_ You can use .XSI files with a .FBX cockpitName, as long as the hierarchy matches.  
    
collisionName = ""  
If specified, this is used as the collision model.  
_Note:_ This overrides default collision, or any \_\_c meshes in the geometryName mesh.  
    
collisionScale = 1.0  
Scale for collisionName mesh.  
    
lightHard1 ... lightHard8 = ""  
This is the model hard point name for the Light. Must be a valid model piece name, no other name restrictions. Typically "HP\_Light\_#".  
    
lightName1 ... lightName8  
This is the ODF name for the corresponding light.  
    
effectHard1 ... effectHard16 = ""  
Model hard point for this Effect. No naming restrictions, but conventionally "HP\_Emit\_#"  
    
effectName1 ... effectName16  
This is the Render name for the Effect.  
    
effectMinAltitude1 ... effectMinAltitude16 = -1e30  
Minimum altitude below ground / water that this effect renders.  
    
effectMaxAltitude1 ... effectMaxAltitude16 = 1e30  
Maximum altitude above ground / water that this effect renders.  
    
effectMinVelocity1 ... effectMinVelocity16 = -1.0f  
If this is >= 0: The minimum velocity this object has to be moving for this effect to render.  
    
effectMaxVelocity1 ... effectMaxVelocity16 = -1.0f  
If this is >= 0: The maximum velocity this object can be moving for the effect to render.  
    
effectMinHealth1 ... effectMinHealth16 = -1.0f  
If this is >= 0: The minimum Health Ratio for this effect to render. Valid values are -1.0 ... 1.0  
    
effectMaxHealth1 ... effectMaxHealth16 = -1.0f  
If this is >= 0: The maximum Health Ratio for this effect to render. Valid values are -1.0 ... 1.0  
    
effectMinAmmo1 ... effectMinAmmo16 = -1.0f  
If this is >= 0: The minimum Ammo Ratio for this effect to render. Valid values are -1.0 ... 1.0  
    
effectMaxAmmo1 ... effectMaxAmmo16 = -1.0f  
If this is >= 0: The maximum Ammo Ratio for this effect to render. Valid values are -1.0 ... 1.0  
    
effectFlags1 ... effectFlags16  
If this is >= 0: Bit Mask for Effect Flags for this effect to render. Values listed below:  
   * Bit 0 (value = 1)  
    Val=1: effect enabled when craft is empty.  
    Val=0: effect disabled if craft is empty  
   * Bit 1 (value = 2)  
    Val=1: effect enabled when craft is occupied by AI.  
    Val=0: effect disabled if craft is not occupied by AI  
   * Bit 2 (value = 4)  
    Val=1: effect enabled when craft is occupied by a player.  
    Val=0: effect disabled if craft is not occupied by a player.  
   * Bit 3 (value = 8)  
    Val=1: effect enabled when craft is undeployed.  
    Val=0: effect disabled if craft is deployed  
    \- bit flag is skipped if not a craft  
   * Bit 4 (value = 16)  
    Val=1: effect enabled when craft is deployed.  
    Val=0: effect disabled if craft is undeployed  
    \- bit flag is skipped if not a craft  
   * Bit 5 (value = 32)  
    Val=1: effect enabled when object is unpowered.  
    Val=0: effect disabled if object is powered  
   * Bit 6 (value = 64)  
    Val=1: effect enabled when object is powered.  
    Val=0: effect disabled if object is unpowered  
   * Bit 7 (value = 128)  
    Val=1: effect enabled when object is not locked down.  
    Val=0: effect disabled if object is locked down  
   * Bit 8 (value = 256)  
    Val=1: effect enabled when object is locked down.  
    Val=0: effect disabled if object is not locked down  
   * Bit 9 (value = 512)  
    Val=1: condition done when movement inputs are pressed.  
    Val=0: skip if movement inputs not pressed.  
   * Bit 10 (value = 1024)  
    Val=1: condition done when movement inputs are not pressed.  
    Val=0: skip if movement inputs are pressed.  
_Note:_ There are 31 bits total, the higher bits aren't currently used.  
    
EffectsMask = 65535  
Starting Effect mask. Bit Mask of which Effects are enabled.  
_Note:_ Mission Scripts can change the Effect Mask.  
    
LightsOnEffectsMask = 65535  
Bit Mask for toggling effects when lights are turned on.  
_Note:_ Only disables effects.  
    
LightsOffEffectsMask = 65535  
Bit Mask for toggling effects when lights are turned off.  
_Note:_ Only disables effects.  
    
InitAnimation = ""  
Animation name for an animation that plays on initial creation.  
    
RunAnimation = ""  
Animation name for an animation that plays after creation.  
    
InitAnimIsLooped = false  
Sets if the InitAnimation is looping or 1-way.  
    
RunAnimIsLooped = true  
Sets if the RunAnimation is looping or 1-way.  
    
turretCount = 0  
How many Turret components this object has. Max is 8  
_Note:_ The first turretName is horizontal (Y), all other turrets are Vertical (X).  
    
turretName1 ... turretName8  
Model piece names for the turret objects.  
    
NumChunks = -1  
Total number of Chunks to generate.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
NumChunks1 ... NumChunks5 = -1  
Number of Chunks per type. Max of 10 for each type.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
Note: Default is calculated based on bounding box, capped to 25.  
    
chunkEffect1 ... chunkEffect5 = "iochnk01.fbx" ... "iochnk05.fbx"  
Model file name for each Chunk. Can be .XSI or .FBX.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
chunkScale1 ... chunkScale5 = 1.0  
Scale for each chunkEffect# model.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
crashName = ""  
Model file name for the Crash model.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
crashScale = 1.0  
Scale of the crashName model.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
hasSeparateChunks = false  
If this is true, it reads SeparateChunkEffect# for separate chunk models. These are the smaller bits that are generated from the Crash model hitting the ground.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
SeparateChunkEffect1 ... SeparateChunkEffect5 = ""iochnk01.fbx" ... "iochnk05.fbx"  
Model file names for separate chunks. Can be .XSI or .FBX.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
SeparateChunkScale1 ... SeparateChunkScale5 = 1.0  
Scale for separateChunkEffect# models.  
_Note:_ Only applies to Class: Building. Class Craft is read under \[CraftClass\].  
    
UseVehicleCrashOnDeath = true  
If false, won't generate a Crash model. Default is false for Class: Torpedo, Walker, non-hover Constructor.

 BuildingClass 

 classlabels: "i76building", "i76sign"  
  
**Class Tree: Entity->GameObject->Building**  
  
**Supported Animations:**  
* Deploy
  
**Description:**  
Building Class is the core class for most Buildings.  
  
**Default ODF Properties:**  

\[GameObjectClass\] hitType = 4 // HIT\_TYPE\_BUILDING

  
**ODF Properties:**  
* **\[BuildingClass\]**  
    
soundAmbient = ""  
This object's Ambient Sound.  
    
soundAmbientDist = 0.05f  
Minimum sound Distance ratio.  
    
AmbeintSoundWhenUnpowered = false  
If this is true, AmbientSound continues to play while this object is unpowered.  
    
bldEdge = ""  
If specified, this is the Building's Tunnel Edge. This consists of 4 letters that represent each side's connection. Connections are in clock-wise order N, E, S, W. Valid values are:  
   * W = Wall  
   * T = Terrain  
   * F = Tunnel  
    
tunnelCount = 0  
How many Tunnel segments are on this object.  
_Note:_ The numbered Tunnel Info below is not ODF inherited if you include this line in the inherited ODF.  
    
Tunnel Info is labeled "tunnel##...", where ## is the count. Starting at 00, and increment to 99\. For each Tunnel Count:  
tunnel00X0 = 0.0  
Starting position on X Axis.  
    
tunnel00Z0 = 0.0  
Starting position on Z Axis.  
    
tunnel00Dx = 0.0  
Size on the X Axis.  
    
tunnel00Dz = 0.0  
Size on the Z Axis.  
    
tunnel00Edge  
This Tunnel Segment's Edge. This consists of 4 letters that represent each side's connection. Connections are in clock-wise order N, E, S, W. Valid values are:  
   * W = Wall  
   * T = Terrain  
   * F = Tunnel  
    
tunnelClusterSize = 4.0f  
Tunnel cluster size.  
    
justTerrain = false  
If true, Pathing includes just the Terrain under this object.  
    
justFlat = false  
If true, Pathing is made completely flat under this object.  
    
easyTunnels = false  
If this is true, it assumes anything can fit through the tunnel regardless of size.  
    
collapseTime = BoundingSphere.height \* 4.0 / Gravity  
This is the time, in seconds, that it takes the Collapse effect to play.  
    
UseCollapse = true  
If this is false, it won't do the Collapse effect. Default is false for Class: i76sign, or if callapseTime is <= 0.  
    
UseChunks = false  
If true, generates Chunks derrived from \[GameObjectClass\] properties.  
    
UseExplosion = !useCallapse  
If this is true, it uses explosionName instead of the Collapse effect.  
    
CanDemolish = true  
If this is false, does not appear in Constructor's Demolish menu.  
    
CanAlliedCommanderDemolish = true  
In an MP Team Play game, sets if the Commander can Demolish this object.  
    
CanAlliedThugDemolish = false  
In an MP Team Play game, sets if a Thug can Demolish this object.  
    
DoBettyLost = true  
If false, won't give Betty VO when this object is destroyed.  
    
Lifespan = -1.0f  
If this is >= 0, how long in seconds until this object goes boom.  
    
ReplacesObject = false  
If this is true, then it acts like an Extractor and replaces the object that was under it. Default is true for Class: Extractor.  
    
AlignsToObject = false  
If this is true, it aligns to face the same direction as the object it's replacing. Default is true for Class: Extractor.  
    
loadAsDummy = false dummyVersion = 0  
Largely depreciated, this appears to have been a way to load a Dummy class (Terrain), which was BZ1's version of Building, as a new Building class. (Skipping the loading of obsolete data). It was probably used in early development in 1999 during upgrading the BZ1 engine.

 CraftClass P1: General Settings 

 Classlabel: "craft"  
  
**Description:**  
Craft Class is the root Class for all Vehicles. It is movable and can be driven.  
  
**Default ODF Properties:**  

\[GameObjectClass\] hitType = 3 // HIT\_TYPE\_VEHICLE needPilot = true canSnipe = true canCollide = true boxCollide = false isGrouped = true needGroup = true isLimited = true needLimit = true

  
**ODF Properties:**  
* **\[CraftClass\]**  
    
rangeScan = 200.0f  
How far the Radar on the craft can see.  
    
periodScan = 0.0f  
How long, in seconds, between Radar Pings.  
    
weaponPitch = 0.5f  
How far up/down the Reticle or Turrets can aim.  
    
MinWeaponPitch = -weaponPitch  
How far down the Reticle or Turrets can aim.  
    
MaxWeaponPitch = weaponPitch  
How far up the Reticle or Turrets can aim.  
    
braccelFactor = 0.05f  
Scale the difference between the desired and current position along the front axis by this value when setting the throttle control.  
    
velFactor = 0.2f  
Scale the difference between desired and current velocity along the front axis by this when setting throttle control.  
    
strafeFactor = 0.1f  
Scale the difference between the desired and current position along the right axis by this value when setting the strafe control.  
    
omegaScale = 0.0f  
If Use13Aim is true, scale the target's rotational velocity around the unit by this factor so the unit can keep up with the target's motion.  
    
alphaScale = 0.0f  
If Use13Aim is true, scale the target's rotational acceleration around the unit by this factor so the unit can compensate for the target's acceleration.  
    
steerFactor = 1.0f  
If Use13Aim is true, scale the target's angular position offset by this factor so the unit can catch up to the target's direction (spring force).  
    
omegaFactor = 0.2f  
If Use13Aim is true, scale the target's angular velocity offset by this factor so the unit doesn't overshoot the target's direction (damping force).  
    
omegaScaleTurret = 0.0f  
Same as omegaScale, but for Turret.  
_Note:_ Default is 1.0 for Class: AssaultHover, AssaultTank, TurretTank.  
    
alphaScaleTurret = 0.0f  
Same as alphaScale, but for Turret.  
_Note:_ Default is 1.0 for Class: AssaultHover, AssaultTank, TurretTank.  
    
steerFactorTurret = 3.0f  
Same as steerFactor, but for Turret.  
    
omegaFactorTurret = 0.25f  
Same as omegaFactor, but for Turret.  
    
avoidSpeed = 20.1234  
How fast the AI should drive when avoiding obstacles.  
    
topSpeed = 30.1234  
How fast the AI should drive when not avoiding obstacles.  
    
engageRange = 200.0f  
How close an Enemy needs to be for being considered a target.  
    
followRange = 125.0f  
How close a unit wants to follow another unit.  
    
blastDist = 75.0f  
How close a unit wants to be by default when using the BLAST state. (Shooting at something)  
    
LookAtPitchFactor = pitchFactor  
Pitch Factor used when the craft is given the LookAt() command.  
    
TeamTransferrable = true  
If false, can't be transferred to Allied Players in MP.  
    
canRescue = true  
If false, can't do the command "Pick Me Up"  
    
canHunt = false  
If true, enables the "Hunt" command.  
    
CanBailout = true  
If false, cannot do the "Bailout" command.  
    
CanRecycle = true  
If false, cannot do the "Recycle" command.  
    
CanUserBailout = true  
If false, the Player cannot bail out via the Ctr+B key bind.  
    
CanUserHopout = true  
If false, the Player cannot hop out via the H key.  
    
CanAIEject = true  
If false, AI cannot eject a pilot from this craft when it dies.  
    
ejectRatio = 0.3f  
The Ratio for the chance that an AI Pilot will Eject out of this object when it dies. Valid values are 0.0f - 1.0f.  
    
ejectVelocity = 50.0f  
The Velocity which the pilot ejects from this craft.  
    
DoIdleDispatch = true  
If false, AIPs cannot send this unit out via Idle Dispatcher.  
    
CraftTeamIsPilotTeam = false  
If this is true, when a Pilot gets into this vehicle, the vehicle inherits the Percieved Team of the Pilot immediately.  
    
CanAIPForceIdle = true  
If false, switching AIPs won't cause this Craft to go Idle.  
    
AllowLightsDeploy = true  
If false, when a unit Deploys, it's lights are toggled off and disabled. When it Undeploys, it's lights toggle back on.  
    
CockpitSniperRadius = 1.0f  
How large the sniper dot radius is.  
    
AllowLinkWeapons = true  
If this is true, allows weaponLinking, assuming other restrictions don't apply such as MP server setting or Play option for Weapon Linking are enabled. If false, this unit cannot use Weapon Linking.  
    
NavConfig = ""  
If this is specified, overrides the Nav ODF dropped by this craft. If invalid, it ignores the setting.  
    
NavIsCraftRace = true  
If NavConfig is not set, and this is true, Nav Beacons dropped by this craft use the craft's Race. If false, uses the Team Race. If neither exist it falls back to ibnav.  
    
NavIsDropped = false  
If true, the Nav is dropped behind the craft like in BZ1/98R.  
    
NavDropSound = "gprox00.wav"  
If NavIsDropped is true, the sound file used upon dropping a Nav.  
    
LeaveExplodeScorch = true  
If false, won't darken the ground when it explodes.  
    
MaxScorchHeight = 20.0f  
Maximum height above ground that it will leave an Explode Scorch.  
    
NumChunks = -1  
Total number of Chunks to generate.  
    
NumChunks1 ... NumChunks5 = -1  
Number of Chunks per type. Max of 10 for each type.  
    
chunkEffect1 ... chunkEffect5 = "iochnk01.fbx" ... "iochnk05.fbx"  
Model file name for each Chunk.  
    
chunkScale1 ... chunkScale5 = 1.0  
Scale for each chunkEffect# model.  
    
crashName = ""  
Model file name for the Crash model.  
    
crashScale = 1.0  
Scale of the crashName model.  
    
hasSeparateChunks = false  
If this is true, it reads SeparateChunkEffect# for separate chunk models. These are the smaller bits that are generated from the Crash model hitting the ground.  
    
SeparateChunkEffect1 ... SeparateChunkEffect5 = ""iochnk01.fbx" ... "iochnk05.fbx"  
Model file names for separate chunks.  
    
SeparateChunkScale1 ... SeparateChunkScale5 = 1.0  
Scale for separateChunkEffect# models.  
    
damageEffect1 ... damageEffect4 = "dmgvhcl1" ... "dmgvhcl4"  
These are the Renders for the Damage Smoke. Below is a list of when they are used:  
   * damageEffect1 starts when the object is below 50% health.  
   * damageEffect2 starts when the object is below 25% health.  
   * damageEffect3 starts when the object is below 12.5% health.  
   * damageEffect4 is used on the Crash model generated when the object explodes.  
    
xplSnipe = "xsnipe"  
The ODF name of the Explosion Class used when this object is Sniped.  
    
xplChunk = ""  
Explosion Class ODF for when a Chunk hits the ground. Default is the race's \*explosion.odf's value for xplChunk.  
    
xplCrash = ""  
Explosion Class ODF for when the vehicle Crash model hits the ground. Default is the race's \*explosion.odf's value for xplCrash.

 CraftClass P2: General Settings 2 

* **\[CraftClass\]**  
    
CondAddAmmoMinRatio1 ... CondAddAmmoMinRatio8 = -1  
Conditional AddAmmo minimum AmmoRatio that this object must be for the conditional to pass.  
    
CondAddAmmoMaxRatio1 ... CondAddAmmoMaxRatio8 = -1  
Conditional AddAmmo maximum Ammo Ratio that this object must be for the conditional to pass.  
    
CondAddAmmoValue1 ... CondAddAmmoValue8 = 0  
Amount of AddAmmo done by this conditional.  
    
CondAddAmmoFlags1 ... CondAddAmmoFlags8 = 2147483647  
Bit Mask for which Flags are used to enable this AddAmmo. Values listed below:  
   * Bit 0 (value = 1)  
    Val=1: condition done when craft is empty.  
    Val=0: skip if craft is empty  
   * Bit 1 (value = 2)  
    Val=1: condition done when craft is occupied by AI.  
    Val=0: skip if craft is not occupied by AI  
   * Bit 2 (value = 4)  
    Val=1: condition done when craft is occupied by human (local/remote player).  
    Val=0: skip if craft is not occupied by human (local/remote player)  
   * Bit 3 (value = 8)  
    Val=1: condition done when craft is undeployed.  
    Val=0: skip if craft is deployed  
    \- bit flag is skipped if not a craft  
   * Bit 4 (value = 16)  
    Val=1: condition done when craft is deployed.  
    Val=0: skip if craft is undeployed  
    \- bit flag is skipped if not a craft  
   * Bit 5 (value = 32)  
    Val=1: condition done when object is unpowered.  
    Val=0: skip if object is powered  
   * Bit 6 (value = 64)  
    Val=1: condition done when object is powered.  
    Val=0: skip if object is unpowered  
   * Bit 7 (value = 128)  
    Val=1: condition done when object is not locked down.  
    Val=0: skip if object is locked down  
   * Bit 8 (value = 256)  
    Val=1: condition done when object is locked down.  
    Val=0: skip if object is not locked down  
   * Bit 9 (value = 512)  
    Val=1: condition done when movement inputs are pressed.  
    Val=0: skip if movement inputs not pressed.  
   * Bit 10 (value = 1024)  
    Val=1: condition done when movement inputs are not pressed.  
    Val=0: skip if movement inputs are pressed.  
    
AllowedControlsWhenTugged = 7  
Bit Mask for which controls are allowed while this object is being Tugged. Valid values:  
   * 1: Allow hop out of vehicle (subject to normal hop out rules)  
   * 2: Allow bailout of vehicle (subject to normal bailout rules)  
   * 4: Allow weapon cycling (next/prev)  
   * 8: Allow pitch/steering (i.e. controls normally on mouse)  
   * 16: Allow weapon firing & special weapon use  
    
PersonRetreatRecycleDist = 25.0f  
For Class Person: How far it must be from the Recycler to be recycled.  
    
EngineSoundOnlyWhenPiloted = false  
If true, won't do Engine sound effects when not Piloted.  
    
EngineSoundWhenDeployed = true  
If false, won't do Engine sound effects when Deployed.  
    
BailSound = "bail.wav"  
Sound file played when this object Bails out.  
    
CollideTerrainSound = "collide03.wav"  
Sound file played when this object collides with Terrain.  
    
CollideBldgSound = "collide02.wav"  
    
CollideOtherSound = "collide01.wav"  
    
ExplodeSound = ""  
The sound when this craft Explodes.  
    
UserCockpitSound = ""  
If specified, the ambient sound when the user is driving this Craft and is in Cockpit View.  
    
AI Unit Message  
    
These are .wav sound files, can be anything. Specified with file extension such as: "blah.wav".  
selectOtherMsg = ""  
Selection Message of the unit while it is doing "Other". Fallback for other Select\* messages if they are not present.  
    
selectWaitMsg = ""  
Selection Message of the unit while it is Idle.  
    
selectGoMsg = ""  
Selection Message of the unit while it is in State: Goto, or GoObject.  
    
selectFollowMsg = ""  
Selection Message of the unit while it is Following something.  
    
selectAttackMsg = ""  
Selection Message of the unit while it is Attacking something.  
    
selectPickupMsg = ""  
Selection Message of the unit while it is Pickuping Up. E.g. Scavengers.  
    
selectDropoffMsg = ""  
Selection Message of the unit while it is Dropping off. E.G. Scavengers.  
    
selectDeployMsg = ""  
Selection Message of the unit while it is Deploying.  
    
selectUser1Msg = ""  
Selection Message of the unit while it is in USTATE. This is a special case mode used by certain classes such as Mine Layers or Scavengers.  
    
selectUser2Msg = ""  
Selection Message of the unit while it is in USTATE2\. This is a special case mode used by certain classes such as Mine Layers or Scavengers.  
    
otherMsg = ""  
Message given when the unit is ordered to do Other. Default fallback for the rest of the following.  
    
goMsg = ""  
Message given when the unit is ordered to Goto a spot on the ground.  
    
goObjectMsg = ""  
Message given when the unit is ordered to Goto an Object, e.g. Nav.  
    
followMsg = ""  
Message given when the unit is ordered to Follow another object.  
    
followMeMsg = ""  
Message given when the unit is ordered to Follow Me. Default is followMsg if not specified.  
    
attackMsg = ""  
Message given when the unit is ordered to Attack.  
    
repairMsg = ""  
Message given when the unit is ordered to Get Repair.  
    
reloadMsg = ""  
Message given when the unit is ordered to Get Reload.  
    
rescueMsg = ""  
Message given when the unit is ordered to Pick Me Up.  
    
recycleMsg = ""  
Message given when the unit is ordered to Recycle.  
    
holdMsg = ""  
Message given when the unit is ordered to Hold.  
    
user1Msg = ""  
Message given when the unit is ordered to do USTATE. Used by: ConstructionRig, DeployBuilding, DeployBuildingH, Minelayer, Scavenger, ScavengerH.  
    
user2Msg = ""  
Message given when the unit is ordered to do USTATE2\. Used by: ConstructionRig, Minelayer, Scavenger, ScavengerH.  
    
deployedMsg = ""  
Message given when the unit is fully Deployed.  
    
packedMsg = ""  
Message given when the unit is fully Undeployed.  
    
killedMsg = ""  
Message given when the unit's current ATTACK target is dead.  
    
modeText0 .. modeText32 = ""  
If specified, these override the menu Text for the Command Panel's actions. Values are:  
   * MODE\_NONE = 0,  
   * MODE\_GO = 1,  
   * MODE\_FOLLOW = 2,  
   * MODE\_PICKUP = 3,  
   * MODE\_DROPOFF = 4,  
   * MODE\_DEPLOY = 5,  
   * MODE\_UNDEPLOY = 6,  
   * MODE\_RESCUE = 7,  
   * MODE\_RECYCLE = 8,  
   * MODE\_GO\_TO\_NAV = 9,  
   * MODE\_SCAVENGE = 10,  
   * MODE\_HUNT = 11,  
   * MODE\_ATTACK = 12,  
   * MODE\_HOLD = 13,  
   * MODE\_LAY\_MINES = 14,  
   * MODE\_DEFEND\_BASE = 15,  
   * MODE\_SERVICE = 16,  
   * MODE\_UPGRADE = 17,  
   * MODE\_DEMOLISH = 18,  
   * MODE\_POWER = 19,  
   * MODE\_BUILD = 20,  
   * MODE\_LAUNCHBOMB = 21,  
   * MODE\_CANCELBOMB = 22,  
   * MODE\_SPLIT\_GROUP = 23,  
   * MODE\_SELECT\_NAV = 24,  
   * MODE\_PLACE\_NAV = 25,  
   * MODE\_SELECT\_SINGLE = 26,  
   * MODE\_VIEW\_UNITS = 27,  
   * MODE\_MORPH\_SETDEPLOYED = 28,  
   * MODE\_MORPH\_SETUNDEPLOYED = 29,  
   * MODE\_MORPH\_UNLOCK = 30,  
   * MODE\_BAILOUT = 31,  
   * MODE\_BUILD\_ROTATE = 32  
    
**AI Task Settings. These must be a valid AI Task.**  
attackTask = "" defendTask = "" waitTask = "" specialTask = "" subAttackTask = ""  
    
subAttackClass = "NNN"  
This contains 3 letters which determine settings for how the AI behaves when Attacking. Valid Values for the first letter are:  
   * N = Only attack Ground targets.  
   * A = Attack Flying targets too.  
Values for second letter are:  
   * N = Attack when Undeployed.  
   * D = Deploy to Attack.  
Values for the third letter are:  
   * N = Use EngageRange for Attacking.  
   * S = Use Weapon's aiRange for Attacking.  
    
GetInRaceMask = -1  
Bitmask of what Race letters are allowed to Hop into this craft.  
    
AIOnly = false  
If true, Players cannot hop into this Object.

 CraftClass P3: General Settings 3 

* **\[CraftClass\]**  
    
DoBettyLost = true  
If false, won't play "Unit Lost" Betty VO.  
    
WeaponsConverge = true  
If false, weapons won't converge on the Target reticle's location.  
    
UseAssaultSpecials = false  
If false, will skip over Special hard points when selecting weapons vs isAssault targets.  
    
HealthChangeLevelDelta = 0.1  
This is the amount of health (percentage, divided by 100) the craft must lose before it sends a "change state" request to its AI process.  
    
MIN\_BOUNCE\_VEL = 0.5  
Minimum collision Bounce Velocity.  
    
OBJECT\_ELASTICITY = 0.125  
Object collision bounce Elasticity.  
    
GROUND\_ELASTICITY = 0.03125  
Ground collision bounce Elasticity.  
    
X\_SPIN\_RATE = 1.5707963267948966  
Collision Bounce velocity spin rate on the X axis.  
    
Y\_SPIN\_RATE = 3.1415926535897932  
Collision Bounce velocity spin rate on the Y axis.  
    
Z\_SPIN\_RATE = 0.7853981633974483  
Collision Bounce velocity spin rate on the Z axis.  
    
DAMAGE\_SCALE = 0.05  
Scale in turning Velocity into Damage from Craft > Ground and Craft > Building collisions.  
    
MAX\_PILOT\_HORIZ\_VELOCITY = 25.0  
Maximum horizontal Velocity of a Pilot ejecting out of this Craft.  
    
RECYCLE\_TASK\_DIST = 10.0  
How far from the Recycler the object must get to Recycle.  
    
PathingType = -1  
Pathing type for this Craft. Valid values are: -1 = auto, 0 = Hover, 1 = Walker, 2 = Person, 3 = Tracked, 4 = Flyer.  
    
AvoidType = -1  
Avoidance type for this Craft. Valid values are: -1 = auto, 0 = None, 1 = force, 2 = plan.  
    
attackRange = 320.0  
Range a target must get before considering to ATTACK.  
    
waitRange = 370.0  
Range that a target must get before switching to WAIT state.  
    
TurretTankAttackRange = 320.0  
Range a target must get before considering to ATTACK.  
_Note:_ Only used by TurretTank Class.  
    
TurretTankWaitRange = 370.0  
Range that a target must get before switching to WAIT state.  
_Note:_ Only used by TurretTank Class.  
    
fireConeXBase = 0.2  
Base firing cone angle on X axis.  
    
fireConeXSkillAdj = -0.05  
Skill multiplier on fireConeXBase.  
    
fireConeYBase = 0.2  
Base firing cone angle on Y axis.  
    
fireConeYSkillAdj = -0.05  
Skill multiplier on fireConeYBase.  
    
AttackTaskBlastDist = 40.0  
How close AttackTask gets before opening fire.  
    
OffensiveProcessMadTime = 30.0  
How long an object stays aggro'ed on the object that shot it.  
    
The below values are for AlternateAnimalProcess AI:  
AltAnimalTCoolDist = 125.0  
 Dist looking for tanks  
    
AltAnimalTYumDist = 75.0  
Dist looking for pilots  
    
AltAnimalTGotoClose = 15.0  
Goto distance.  
    
AltAnimalTGotoCloseMax = 30.0  
Max Goto distance.  
    
AltAnimalTFleeDist = 75.0  
Flee distance.  
    
AltAnimalTGoto2AttackDist = 15.0  
How close we need to be to switch from GOTO to ATTACK  
    
AltAnimalTDontStand = false  
If true, won't stand still for long while wandering.  
    
The below values are for BoidProcess AI:  
BoidTaskInfluenceRadius = 50.0  
Influence Radius.  
    
BoidTaskCollisionFraction = 0.8  
Collision fraction between Boid objects.  
    
BoidTaskNormalSpeed = 0.75  
Normal forward speed.  
    
BoidTaskAngleTweak = 0.06  
Amount it changes angle when pitching up or down.  
    
BoidTaskPitchToSpeedRatio = 0.002  
How much it slows down when changing Pitch.  
    
The below values are for LandAnimalProcess AI:  
LandAnimalTCoolDist = 125.0  
Dist looking for tanks  
    
LandAnimalTYumDist = 75.0  
Dist looking for pilots  
    
LandAnimalTGotoClose = 15.0  
Goto distance.  
    
LandAnimalTGotoCloseMax = 30.0  
Max Goto distance.  
    
LandAnimalTFleeDist = 75.0  
Flee distance.  
    
LandAnimalTGoto2AttackDist = 15.0  
How close we need to be to switch from GOTO to ATTACK  
    
LandAnimalTDontStand = false  
If true, won't stand still for long while wandering.  
    
CraftClassPilotMask = 0  
Bit Mask for use with \[PersonClass\]::PersonClassPilotProvides to filter which pilots can enter this a vehicle.  
    
CraftClassPilotMatch = 0  
Bit Mask for use with PersonClassPilotMask and \[PersonClass\]::PilotClassPilotProvides to filter which pilots can enter this a vehicle.  
    
CraftClassPilotProvides = 0  
Bit Mask for what use with \[PersonClass\]::PersonClassPilotMask and \[PersonClass\]::PersonClassPilotMatch to filter which pilots can enter this a vehicle.

 CraftClass P4: AI Settings 

* **\[CraftClass\]**  
    
RetargetOnStrafe = false  
If this is true, when this unit is shot while engaging it's Target, and enters mode STRAFE to evade, it switches it's Target to the object that shot it.  
    
EndSlideWhenCanHit = true  
If true, exits SLIDE state as soon as it think it can hit it's Target.  
    
MustBeLinedUpToHit = false  
If this is true, AbleToHit calculation accounts for current heading and fire cone angles.  
_Note:_ Might not work very well on objects with Turrets.  
    
MustBeLinedUpToFire = false  
Same as MustBeLinedUpToHit but only applies to ArtillaryProcess AI. Defaults to true for Class: Artillary.  
    
AITargetLocation = -1  
Target Location for where the AI aims at it's target. Valid values: -1 = default, 0 = center, 1 = high, 2 = low, 3 = left, 4 = right  
    
GotoTaskHasLeader = true  
If false, Goto task given to Groups will not use Leader/Follower behavior, and all units in the Group will make their own individual paths.  
    
WingmanProcessAttackMines = true  
If true, WingmanProcess AI will attacks Mines.  
    
NonWingmanProcessAttackMines = false  
If true, Non WingmanProcess AI will attack Mines.  
    
AIWeaponMaskVsCombat = -1  
If this is >= 0, controls what weaponMask is used vs non isAssault objects.  
    
AIWeaponMaskVsAssault = -1  
If this is >= 0, controls what weaponMask is used vs isAssault objects.  
    
SitTaskEnemySearchDist = 0.0f  
This is how far it will search for Targets while sitting idle. Max is the craft's rangeScan.  
    
ClosestEnemyGoodEyes = false  
If this is true, GetClosestEnemyWithin() AI function considers objects behind them, else it only considers things in front of them.  
    
GunTowerProcessCheckCantHit = true  
If this is true, GunTowerProcess will re-target if it can't hit it's current Target.  
    
DoWeaponCanHitCheck = true  
If false, won't perform a CanHit check before trying to fire a Weapon at it's Target. If true, will skip over weapons that can't hit.  
    
IgnoreDestroyedTargets = true  
If true, AI ignores things flagged as Destroyed.  
    
IgnorePerceivedTeam = false  
If this is true, AI will ignore an Enemy's PercievedTeam setting.  
    
ScanLocalAmmo = false  
If true, AIP, MorphTank switching, and MortarBikeProcess code that compares ammoRatio takes all the weapon's LocalAmmo into account.  
    
AircraftAttackMustDeploy = false  
If AirCraftFriend/Enemy AI is in use, and this is true, if it is Undeployed when ordered to Attack, it will Deploy to takeoff.  
    
OffensiveProcessIsTenacious = true  
If this is true, AI units on a Player's Team will keep attacking it's current Target.  
    
OffensiveProcessIsTenaciousAITeam = false  
If this is true, AI units on a non Player Team will keep attacking it's current Target.  
    
OffensiveProcessIsDistractable = false  
If this is true, units on a Player's Team that are shot while en-route to their Attack target, will switch to Target their object that shot them.  
    
OffensiveProcessIsDistractableAITeam = true  
If this is true, units on an AI's Team that are shot while en-route to their Attack target, will switch to Target their object that shot them.  
    
AttackTaskUsesGroups = true  
If true, Attack orders given to Groups will use Leader/Follower behavior. If false, units will path individually.  
    
FireWhenCanHitFriends = false  
If true, will fire even if a Friendly unit is in the line of fire.  
    
SitAttackCheckAbleToHit = false  
If true, when WAIT task times out or the unit is hit by enemy fire, it does a CanHit check before switching to ATTACK. Default is true for Class: TrackedVehicle and TurretTank.  
    
DoBlastUsesFields = false  
If this is true, skips terrain and obstacle avoidance in Pathing when in BLAST state.  
    
SkipSitIfCanHit = true  
If true, skips DoSit when it thinks it can hit it's Target. Also skips updating Avoid/Wait, and the Stop request when a ServiceTruck wants to service something.  
    
UseSelectWeapon = true  
If true, most AI Processes ignore wepaonMask and use their SelectedWeapon. If false, uses weaponMask instead. SelectWeapon uses AIWeaponMaskVsComat/AIWeaponMaskVsAssault and chooses Assault weapons vs Targets with isAssault.  
    
SitAttackAllowIndependence = false  
If true, units in SIT state (idle) will automatically move to engage an Enemy within engageRange.  
    
SitAttackAllowCounterattack = false  
If this is true, the unit will switch to ATTACK state if it is shot from out side it's engageRange.  
_Note:_ Default is true for Class: HoverCraft.  
    
Use13Aim = true  
If this is false, 1.2 patch's Aim code, which uses the Aim12\* skill settings below.  
    
AII Skill Settings  
    
_Note:_ These settings all have 4 settings, one for each Skill level: 0 - 3\. Defaults are listed in that order.  
filterFactor0 ... filterFactor3 = 0.4, 0.6, 0.8, 1.0  
If Use13Aim is true, how much Craft AimAt can change the pitch and steering values per simulation turn (0.0 is none, 1.0 is full).  
    
StrafeTimeBase0 ... StrafeTimeBase3 = 0.5, 1.0, 3.0, 5.0  
The minimum time that WingmanProcess wants to stay in the STRAFE state.  
    
StrafeTimeRandom0 ... StrafeTimeRandom3 = 0.5, 1.0, 1.5, 2.0  
The maximum Random time added to StrafeTimeBase#.  
    
Aim12Delay0 ... Aim12Delay3 = 0.1, 0.06, 0.2, 0.3  
Only used if Use13Aim is false. How much Craft AimAt can change the steering value per simulation turn (0.0 is none, 1.0 is full).  
    
HoverAim12Delay0 ... HoverAim12Delay3 = 0.5, 0.2, 0.666  
Only used if Use13Aim is false. How much HoverCraft AimAt can change the steering value per simulation turn (0.0 is none, 1.0 is full)  
    
AssaultAim12Delay0 ... AssaultAim12Delay3 = 0.7, 0.7, 0.7, 0.7  
Only used if Use13Aim is false. How much AssaultTank AimAt can change the turret steering value per simulation turn (0.0 is none, 1.0 is full)  
    
Aim12CannonError0 ... Aim12CannonError3 = 0.75, 0.5, 0.2, 0.0  
Only used if Use13Aim is false. How much to subtract from the Cannon GetLeadPosition leading time when aiming.  
    
AttackTaskAttackTimeout0 ... AttackTaskAttackTimeout3 = 8.0, 12.0, 16.0, 20.0  
How long AttackTask will remain in the STAND state before timing out and proceeding to the FLEE state to move to a new location.  
    
AttackTaskFleeTimeout0 ... AttackTaskFleeTimeout3 = 50.0, 40.0, 30.0, 20.0  
How long AttackTask will remain in the FLEE state before timing out and proceeding to the STRAFE or BLAST state.  
    
AttackTaskStrafeAfterFlee0 ... AttackTaskStrafeAfterFlee3 = false, false, false, true  
If true, AttackTask switches to STRAFE, else switches to BLAST states.  
    
AttackTaskStrafeToFleeTimeout0 ... AttackTaskStrafeToFleeTimeout3 = 0.0, 25.0, 50.0, 75.0  
How long AttackTask will remain in the STRAFE state before timing out and proceeding to the "flee" state to move to a new location.  
    
evadeRandomFactor0 ... evadeRandomFactor3 = 0.0, 5.0, 10.0 15.0  
How much random Evasion force UnitTask applies (0 = none, 40 = comparable to maximum object or cliff avoidance).  
    
evadeSightFactor0 ... evadeSightFactor3 = 0.0, 10.0, 20.0, 20.0  
how much line-of-sight Evasion force UnitTask applies (0 = none, 40 = comparable to maximum object or cliff avoidance).  
    
evadeOrdnanceFactor0 ... evadeOrdnanceFactor3 = 0.0, 0.0, 0.0, 20.0  
how much ordnance Evasion force UnitTask applies (0 = none, 40 = comparable to maximum object or cliff avoidance).  
    
evadeFilterFactor0 ... evadeFilterFactor3 = 0.0, 3.0, 4.0, 5.0  
Low-pass filtering constant for Evasion controls (0 disabling the feature entirely and higher values having tighter control).

 AircraftClass 

 classlabel: "aircraft"  
  
**Class Tree: Entity->GameObject->Craft->Aircraft**  
  
**Supported Animations:**  
* Forward
* Neutral
* Reverse
* Deploy
  
**Description:**  
Aircraft Class is a flying unit that is not effected by Gravity, and depending on physics settings, can spin/tilt any direction. It flies similar to a flight simulator. It starts out Undeployed (landed), and can use the Deploy function to takeoff/land.  
  
Aircraft Class has 3 movement states: Low, Medium, and High. Low is used when pressing the Reverse key. Medium is neutral, neither pressing Forward or Reverse. High is used when pressing the Forward.  
  
**Recommmended AI Process:**  

aiName = "AirCraftFriend" aiName2 = "AirCraftEnemy"

  
**ODF Properties:**  
* **\[AirCraftClass\]**  
    
velocSet(L) = 10.0f  
Velocity while pressing Reverse  
    
velocSet(M) = 30.0f  
Velocity while idling.  
    
velocSet(H) = 100.0f  
Velocity while pressing Forward.  
    
accelThrust = 10.0f  
Acceleration while moving Forward.  
    
accelBrake = 20.0f  
Acceleration while Braking.  
    
accelDrag = 30.0f  
Acceleration Drag.  
    
omegaSteer(L) = 1.0f  
Steering rate at Low speed.  
    
omegaSteer(M) = 1.5f  
Steering rate at Medium speed.  
    
omegaSteer(H) = 2.0f  
Steering turn rate at High speed.  
    
omegaStrafe(L) = 2.0f  
Srafing turn rate at Low speed.  
    
omegaStrafe(M) = 3.0f  
Srafing turn rate at Medium speed.  
    
omegaStrafe(H) = 4.0f  
Srafing turn rate at High speed.  
    
alphaSteer = 3.0f  
Steering acceleration.  
    
alphaStrafe = 5.0f  
Strafing acceleration.  
    
minAltitude = 10.0f  
Minimum Altitude this unit can fly at.  
    
maxAltitude = 100.0f  
Maximum altitude above ground this unit can fly at.  
    
alphaLevel = 10.0f  
Leveling acceleration.  
    
alphaDamp = 5.0f  
Damping acceleration.  
    
pitchPitch = 1.0f  
Min/Max Pitch angle.  
    
rollStrafe = 0.0f  
Roll angle while strafing.  
    
rollSteer = 0.2f  
Roll angle while steering.  
    
timeDeploy = 5.0f  
Time, in seconds, to deploy.  
    
timeUndeploy = 5.0f  
Time, in seconds, to undeploy.  
    
aiAltitude = minAltitude + ((maxAltitude - minAltitude) \* 0.25f);  
    
LiftSpring = Gravity Setting.  
Takeoff/Landing lift spring.  
    
AILiftSpring = 2.0f  
AI Takeoff/Landing lift spring.  
    
flameName1 .. flameName16 = "flame\_1" .. "flame\_16" flameTextureName1 .. flameTextureName16 = "trail.tga" flameSpriteName1 .. flameSpriteName16 = "splash.0"  
Engine flame override settings.  
    
soundThrust = "engthrst.wav"  
Engine Thrust sound.  
    
soundBrake = "wmflame.wav"  
Engine steering sound.  
    
soundDeploy = "wmflame.wav"  
Deploy sound.  
    
soundUndeploy = "wmflame.wav"  
Undeploy sound.  
    
OverWaterFlying = true  
If Min/MaxAltitude uses Water height, or Terrain height.  
    
OverWaterLanded = true  
If landing uses Water height or Terrain height.  
    
AlwaysDeployed = false  
If true, always deployed.  
    
AlwaysUndeployed = false  
If true, always undeployed.  
    
AltitudeLookahead = 2.0f  
\# of seconds it will look ahead for adjusting altitude.  
    
MaxTakeoffSpeed = 5.0f  
Highest speed you can be going to Takeoff.

 APCClass 

 Classlabel: "apc"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->APC**  
  
**Supported Animations:**  
* Forward
* Neutral
* Reverse
* Deploy
  
**Description:**  
APC Class is a high Flying type of object. It uses \[HoverCraftClass\] parameters but has it's own unique flight physics. It starts out immobile in a Deployed state. It Undeploys to move. When it lands, it ejects Soldiers in a star pattern around it. When it Undeploys, it waits for the Soldiers to return to it before lifting off.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 22 \[CraftClass\] canRescue = false

  
**Recommended AI Process:**  

aiName = "APCProcess"

  
**ODF Properties:**  
* **\[APCClass\]**  
    
flightAltitude = 100.0f  
How high above ground it flies when Undeployed.  
    
timeDeploy = 5.0f  
How long in seconds it takes to Deploy.  
    
timeUndeploy = 5.0f  
How long in seconds it takes to Undeploy.  
    
maxUndeployTime = 20.0f  
How many seconds it will wait for Soldiers to return, before instantly returning them and lifting off.  
    
soundDeploy = "trdeploy.wav"  
Sound file to play when Deploying.  
    
soundUndeploy = "trundepl.wav"  
Sound file to play when Undeploying.  
    
soldierCount = 1  
How many soldiers to spit out when Deployed. Max is 16.  
    
soldierDelay = 1.0f  
How many seconds between each soldier ejecting out when Deploying.  
    
SoldierExtraLife = 120.0f  
How many seconds the APC's Soldiers can exist after the APC is destroyed.  
    
SoldierAltitude = 50.0f  
The Altitude while Deploying at which Soldiers start spitting out.  
    
InternalSoldiersAreAmmo = false  
If this is true, Ammo amount shows how many Soldiers are in the APC.  
    
soldierType = ""  
The ODF name of this APC's "soldier". Can be any GameObjectClass.  
    
OverWater = true  
If false, Altitude ignores water height.  
    
AltitudeLookahead = 1.0f  
\# of seconds it will look ahead for adjusting Altitude.  
    
CanReloadAtRecycler = true  
If false, can't reload at a Recycler.  
    
reloadClass = ""  
If set, will reload here instead of Barracks.  
    
HovercraftPhysicsWhenUndeployed = false  
If this is true, it uses HoverCraft physics while it is Undeployed.  
_Note:_ This does not include transition states of Deploying and Undeploying, only when fully Undeployed.  
    
UseRecallSoldiers = true  
If this is false, won't try to make soldiers return to a star pattern around the APC when idle.  
    
RecallSoldiersTimeout = 30.0f  
Time out of RecallSoldiers around APC.

 ArmoryClass 

 classlable: "armory"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->Armory**  
  
**Description:**  
Armory Class is a type of Factory that can build and launch GameObject Class entities across the world.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 3 // TEAM\_SLOT\_ARMORY isSingle = true

  
**Recommended AI Process:**  

aiName = "ArmoryProcess" aiName2 = "ArmoryProcess"

  
**ODF Properties:**  
* **\[FactoryClass\]**  
    
BaseSlot = 3  
If this is specified, it is the Team Slot this object takes up. Valid values are 2-9.
  
* **\[ArmoryClass\]**  
    
soundBuild = ""  
Sound played while building something.  
    
soundCancel = ""  
Sound played when something under construction is cancelled.  
    
soundFinish = ""  
Sound played when something under construction is finished.  
    
scaleVelY = 2.0f  
Multiplier on vertical launch velocity.  
    
DropoffDX = 0  
Default Dropoff location X distance.  
    
DropoffDZ = 32.0f  
Default Dropoff location Z distance.  
    
DropoffConfig = ""  
If this is specified, overrides the Dropoff ODF dropped by this object. If invalid, it ignores the setting.  
    
buildItem1 ... buildItem10 = ""  
The ODF name to build. If no ArmoryGroup is specified, it uses these as the top level build items.
  
For each Armory Group...  
  
* **\[ArmoryGroup1\]** ... **\[ArmoryGroup10\]**  
    
buildLabel = ""  
The name for this ArmoryGroup displayed in the Command Panel window.  
    
buildItem1 ... buildItem10 = ""  
The ODF name to build.

 ArtifactClass 

 classlabel: "artifact"  
  
**Class Tree: Entity->GameObject->Building->Artifact**  
  
**Description:**  
Artifact class is a type of i76sign that while it is a Building, it can still be moved. It is useful for an object to pickup with a Tug.  
  
**Default ODF Properties:**  

\[GameObjectClass\] AllowUndergroundSpawn = false canCollide = true boxCollide = true

  
**Recommended AI Process:**  

aiName = "PowerUpProcess"

 ArtilleryClass 

 classlabel: "artillery"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Deployable->TurretTank->Artillery**  
  
**Supported Animations:**  
* Forward
* Neutral
* Reverse
* Deploy
  
**Description:**  
Artillery is Deployable, IsFlying turret. It deploys to attack, like a normal Deployable does.  
  
**Default ODF Properties:**  

\[CraftClass\] mustBeLinedUpToFire = true

  
**Recommended AI Process:**  

aiName = "AttachOffensive" aiName2 = "AttachOffensive"

  
**ODF Properties:**  
* **\[ArtilleryClass\]**  
    
HovercraftPhysicsWhenUndeployed = false  
If true, it uses HoverCraft physics when Undeployed.  
_Note:_ This does not apply to Deploying and Undeploying transitional states, only fully Undeployed.  
    
omegaTurret = 2.0f  
Turret turn speed.  
    
alphaTurret = 5.0f  
Turret turn acceleration.  
    
heightDeploy = 0.0f  
Height above ground when deployed.  
    
timeDeploy = 5.0f  
Time in seconds to Deploy.  
    
timeUndeploy = 5.0f  
Time in seconds to Undeploy.  
    
soundDeploy = "trdeploy.wav"  
Sound file for Deploying.  
    
soundUndeploy = "trundepl.wav"  
Sound file for Undeploying.

 AssaultHoverClass 

 Classlabel: "assaulthover"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->AssaultHover**  
  
**Supported Animations:**  
* Forward
* Neutral
* Reverse
  
**Description:**  
AssaultHover is a hovering AssaultTank. It has a Turret and it's strafe controls steer it.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 22 canSnipe = false \[CraftClass\] pitchPitch = 0.0f

  
**Recommended AI Process:**  

aiName = "AssaultTankProcess" aiName2 = "AssaultTankProcess"

  
**ODF Properties:**  
* **\[AssaultHoverClass\]**  
    
yawRate = 2.0f  
Turret turn speed.  
    
yawAlpha = 5.0f  
Turret turn acceleration.  
    
yawMin = -1e30  
Min Turret turn angle.  
    
yawMax = 1e30  
Max Turret turn angle.  
    
pitchMin =-0.5f  
Minimum Pitch angle.  
    
pitchMax = 0.5f  
Maximum Pitch angle.  
    
pitchFilter = 5.0f  
Pitch acceleration.

 AssaultTankClass 

 Classlabel: "assaulttank"  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle->AssaultTank**  
  
**Description:**  
AssaultTank is a turreted Tracked vehicle. It has a Turret and it's strafe controls steer it.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 22 canSnipe = false

  
**Recommended AI Process:**  

aiName = "AssaultTankProcess" aiName2 = "AssaultTankProcess"

  
**ODF Properties:**  
* **\[AssaultTankClass\]**  
    
yawRate = 2.0f  
Turret turn speed.  
    
yawAlpha = 5.0f  
Turret turn acceleration.  
    
yawMin = -1e30  
Min Turret turn angle.  
    
yawMax = 1e30  
Max Turret turn angle.  
    
pitchMin =-0.5f  
Minimum Pitch angle.  
    
pitchMax = 0.5f  
Maximum Pitch angle.  
    
pitchFilter = 5.0f  
Pitch acceleration.

 BarracksClass 

 classlabel: "barracks"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->Barracks**  
  
**Description:**  
Barracks is a building that looks for nearby Empty vehicles, and if it finds one, a pilot hops out of the building to get into it.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 10 // TEAM\_SLOT\_TRAINING isSingle = true

  
**ODF Properties:**  
* **\[BarracksClass\]**  
    
pilotName = ""  
ODF name for the pilot that jumps out of this building. If not specified, it is race's \_spilo ODF.  
    
downTime = 5.0f  
The time in seconds between a pilot hopping out.  
    
ScaleVelUp = 20.0f  
Vertical velocity applied to the Pilot that jumps out of this building.

 BoidClass 

 Classlabel: "boid"  
  
**ClassTree: Entity->GameObject->Craft->Boid**  
  
**Supported Animations:**  
* Fly
  
**Description:**  
This object flies around on it's own, and is not effected by collisions.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY

  
**Recommended AI Process:**  

aiName = "BoidProcess"

  
**ODF Properties:**  
* **\[Boid\]**  
    
animRate = 10.0f  
    
NormalSpeed = 30.0f

 BomberClass 

 Classlabel: "bomber"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Bomber**  
  
**Supported Animations:**  
* Forward
* Neutral
* Reverse
* Deploy
  
**Description:**  
Bomber is a type of Hovercraft that is a Flier. It uses \[HoverCraftClass\] but has it's own unique physics.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 27 // TEAM\_SLOT\_BOMBER isSingle = true tuggable = 0 \[CraftClass\] canRescue = false

  
**Recommended AI Process:**  

aiName = "BomberProcess" aiName2 = "BomberProcess"

  
**ODF Properties:**  
* **\[BomberClass\]**  
    
flightAltitude = 100.0f  
Altitude above ground that it flies.  
    
timeDeploy = 5.0f  
Time in seconds to Deploy.  
    
timeUndeploy = 5.0f  
Time in seconds to Undeploy.  
    
soundDeploy = "trdeploy.wav"  
Sound file played when it Deploys.  
    
soundUndeploy = "trundepl.wav"  
Sound file played when it Undeploys.  
    
reloadTime = 5.0f  
Time it takes to Reload at the Bomber Bay before it can be re-ordered to Attack.  
    
TargetEngageRange = 50.0f  
Used to tell how close to the target the Bomber has to be to drop the bomb.  
    
bombName = "apwrck"  
ODF name of the Bomb. Must be a GameObject Class.  
    
repairRate = 10.0f  
The amount of health repaired per second while landed on the Bomber Bay.  
    
OverWater = true  
Setting for if setAltitude is over Water height or Terrain height.  
    
AltitudeLookahead = 2.0f  
This is the number of seconds to lookAhead for adjusting Altitude.  
    
BayConfig = ""  
This is the ODF of the Bomber Bay to use.  
_Note:_ If the BomberBay has a CategoryTypeOverride this _must_ be used to make it match.  
    
AiCommandToBomb = 3  
This is the AI Command given to the Bomb dropped by this bomber. Default is 3 (CMD\_GO)  
_Note:_ Most Commands probably won't work as expected.  
    
AddPilotToBomb = false  
If this is true, gives the Bomb a Pilot.

 BomberBayClass 

 classlabel: "bomberbay"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->BomberBay**  
  
**Description:**  
A Bomber Bay is a building that spawns an object when it is built.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 11 // TEAM\_SLOT\_BOMBERBAY isSingle = true needGroup = true needLimit = true

  
**ODF Properties:**  
* **\[BomberBayClass\]**  
    
bomberType = ""  
This is the ODF name of the Bomber. If a bomber doesn't exist for this Bay, it spawns one if the building is Powered. Must be a GameObject Class.  
    
downTime = 25.0f  
Depreciated value. Uses \[BomberClass\]::reloadTime instead.

 CameraPodClass 

 Classlabel: "camerapod"  
  
**Class Tree: Entity->GameObject->Powerup->CameraPod**  
  
**Description:**  
Camera Pods are similar to Navs but they provide a Scanner, and when selected that provide a Target Camera view.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canInteract = true canSelect = true

  
**Recommended AI Process:**  

aiName = "CameraPodProcess"

  
**ODF Properties:**  
* **\[CameraPodClass\]**  
    
rangeScan = 200.0f  
How far the Radar range is.  
    
periodScan = 0.0f  
The interval in seconds between Radar Pings

 CommBunkerClass 

 Classlabel: "commbunker"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding-CommBunker**  
  
**Description:**  
CommBunker is a build that supports logging in via a Terminal to activate Satellite View.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 16 // TEAM\_SLOT\_COMM canSelect = false

  
**Recommended AI Process:**  

aiName = "CommTowerProcess" aiName2 = "CommTowerProcess"

  
**ODF Properties:**  
* **\[CommBunkerClass\]**  
    
rangeScan = 300.0f  
This object's Radar range.  
    
periodScan = 0.0f  
The interval in seconds between Radar Pings.  
    
viewDist = 100.0f  
Initial view distance while in Satellite mode in this object.  
    
MinViewDist = viewDist  
Minimum view distance while in Satellite mode in this object.  
    
MaxViewDist = viewDist  
Maximum view distance while in Satellite mode in this object.  
_Note:_ If the MaxViewDist is less then the MinViewDist, the values are swapped.  
    
viewZoom = 1.0f  
Initial Zoom of the Camera.  
    
minZoom = 1.0f  
Minimum Zoom level.  
    
maxZoom = 1.0f  
Maximum Zoom level.  
    
viewPitch = 0.7853975f  
Initial Pitch of the Camera.  
    
minPitch = 0.0f  
Minimum Pitch level.  
    
maxPitch = 1.570795f  
Maximum Pitch level.  
    
viewYaw = 0.0f  
Initial Yaw of the Camera. (0 is Up / North)  
    
minYaw = -1e30  
Minimum Yaw.  
    
maxYaw = 1e30  
Maximum Yaw.  
    
nearPlane = 1.0f  
The Camera Near Plane cutoff. Objects closer then this are not rendered.  
    
farPlane = 500.0f  
The Camera Far Plane cutoff. Objects further then this are not rendered.  
    
disableFog = false  
If this is true, disables the Fog in the Satellite view.  
    
DoBettyOn = true  
If this is true, it plays the Race's \*event.odf's value for EVENT\_SOUND\_10 "Satellite View Activated"  
    
DoBettyOff = true  
If this is true, it plays the Race's \*event.odf's value for EVENT\_SOUND\_15 "Satellite View Deactivated"

 CommTowerClass 

 Classlabel: "commtower"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->CommBunker->CommTower**  
  
**Description:**  
This is the same as CommBunker, but has the following defaults:  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 14 //TEAM\_SLOT\_COMMTOWER isSingle = true; buildRequire = "B" buildSupport = "B" \[CommBunkerClass\] rangeScan = 500.0f;

 CommVehicleClass 

 Classlabel: "commvehicle"  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle->TrackedDeployable->CommVehicle**  
  
**Description:**  
Comm Vehicles are mobile, Tracked, Comm Bunkers. Deploying activates Satellite View.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY

  
**ODF Properties:**  
* **\[CommVehicleClass\]**  
    
rangeScan = 300.0f  
This object's Radar range.  
    
periodScan = 0.0f  
The interval in seconds between Radar Pings.  
    
viewDist = 100.0f  
Initial view distance while in Satellite mode in this object.  
    
MinViewDist = viewDist  
Minimum view distance while in Satellite mode in this object.  
    
MaxViewDist = viewDist  
Maximum view distance while in Satellite mode in this object.  
_Note:_ If the MaxViewDist is less then the MinViewDist, the values are swapped.  
    
viewZoom = 1.0f  
Initial Zoom of the Camera.  
    
minZoom = 1.0f  
Minimum Zoom level.  
    
maxZoom = 1.0f  
Maximum Zoom level.  
    
viewPitch = 0.7853975f  
Initial Pitch of the Camera.  
    
minPitch = 0.0f  
Minimum Pitch level.  
    
maxPitch = 1.570795f  
Maximum Pitch level.  
    
viewYaw = 0.0f  
Initial Yaw of the Camera. (0 is Up / North)  
    
minYaw = -1e30  
Minimum Yaw.  
    
maxYaw = 1e30  
Maximum Yaw.  
    
nearPlane = 1.0f  
The Camera Near Plane cutoff. Objects closer then this are not rendered.  
    
farPlane = 500.0f  
The Camera Far Plane cutoff. Objects further then this are not rendered.  
    
disableFog = false  
If this is true, disables the Fog in the Satellite view.  
    
DoBettyOn = true  
If this is true, it plays the Race's \*event.odf's value for EVENT\_SOUND\_10 "Satellite View Activated"  
    
DoBettyOff = true  
If this is true, it plays the Race's \*event.odf's value for EVENT\_SOUND\_15 "Satellite View Deactivated"

 CommVehicleHClass 

 Classlabel: "commvehicleH"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Deployable->CommVehicleH**  
  
**Description:**  
Comm Vehicles are mobile, Hover, Comm Bunkers. Deploying activates Satellite View.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY

  
**ODF Properties:**  
* **\[CommVehicleHClass\]**  
    
rangeScan = 300.0f  
This object's Radar range.  
    
periodScan = 0.0f  
The interval in seconds between Radar Pings.  
    
viewDist = 100.0f  
Initial view distance while in Satellite mode in this object.  
    
MinViewDist = viewDist  
Minimum view distance while in Satellite mode in this object.  
    
MaxViewDist = viewDist  
Maximum view distance while in Satellite mode in this object.  
_Note:_ If the MaxViewDist is less then the MinViewDist, the values are swapped.  
    
viewZoom = 1.0f  
Initial Zoom of the Camera.  
    
minZoom = 1.0f  
Minimum Zoom level.  
    
maxZoom = 1.0f  
Maximum Zoom level.  
    
viewPitch = 0.7853975f  
Initial Pitch of the Camera.  
    
minPitch = 0.0f  
Minimum Pitch level.  
    
maxPitch = 1.570795f  
Maximum Pitch level.  
    
viewYaw = 0.0f  
Initial Yaw of the Camera. (0 is Up / North)  
    
minYaw = -1e30  
Minimum Yaw.  
    
maxYaw = 1e30  
Maximum Yaw.  
    
nearPlane = 1.0f  
The Camera Near Plane cutoff. Objects closer then this are not rendered.  
    
farPlane = 500.0f  
The Camera Far Plane cutoff. Objects further then this are not rendered.  
    
disableFog = false  
If this is true, disables the Fog in the Satellite view.  
    
DoBettyOn = true  
If this is true, it plays the Race's \*event.odf's value for EVENT\_SOUND\_10 "Satellite View Activated"  
    
DoBettyOff = true  
If this is true, it plays the Race's \*event.odf's value for EVENT\_SOUND\_15 "Satellite View Deactivated"

 ConstructionRigClass 

 Classlabel: constructionrig  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Deployable->ConstructionRig**  
  
**Supported Animations:**  
* Idle
* Idle2
* Idle3
* Walk
* Run
* Turn
* Sitdown
* Death
* Death2
* Death3
* Cons
* Cons2
* Cons3
  
**Description:**  
Construction Rigs are a unique type of Hovercraft, which are actually Walkers. They use \[HoverCraftClass\] settings, but have their own unique physics/animation support. There is also an ODF property to set the unit as a Hover rig, as opposed to the walker type.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 26 // TEAM\_SLOT\_CONSTRUCT needPilot = false \[CraftClass\] canRescue = false \[HoverCraftClass\] setAltitude = 3.0f

  
**Recommended AI Process:**  

aiName = "RigFriend" aiName2 = "RigEnemy"

  
**ODF Properties:**  
* **\[ConstructionRigClass\]**  
    
stepSound = ""  
Sound of stepping on Terrain.  
    
splashSound = ""  
Sound of stepping on Water.  
    
soundBuild = ""  
Sound file played while building.  
    
soundFinish = ""  
Sound file played when building finishes.  
    
ChromeEffect = false  
If true, builds using Chrome method. Default is true for Race f.  
    
ChromeTexture = ""  
Environment texture applied to Chrome effect. Default is the world's environment texture.  
    
BuildSparkConfig = "sparker"  
Render name for the Build effect. Only used if ChromeEffect is false.  
    
LineStartColor = "0 127 255 255"  
Starting color for Build effect's Extrude lines.  
    
LineFinishColor = "0 0 255 0"  
Finish color for Build effect's Extrude lines.  
    
BeamColor = "0 127 255 31"  
Color for Build effect's beams that go from hp\_special on constructor object to Extrude lines)  
    
lineSolidColor = "0 63 255 127"  
LOD line Color for Build effect.  
    
SolidColorDistance = 150.0f  
LOD distance for Build effect's Extrude to switch to lineSolidColor.  
    
MaxLineDistance = 250.0f  
Max distance for Build effect's Extrude efffect.  
    
HoverRig = false  
If true, does the normal HoverCraft stuff. (including Animations of Deployable / HoverCraft)  
    
buildItem1 ... buildItem10 = ""  
The ODF name to build. If no BuildGroup is specified, it uses these as the top level build items.
  
For each Build Group...  
  
* **\[BuildGroup\]** ... **\[BuildGroup\]**  
    
buildLabel = ""  
The name for this BuildGroup displayed in the Command Panel window.  
    
buildItem1 ... buildItem10 = ""  
The ODF name to build.

 ConstructionRigTClass 

 Classlabel: constructionrigT  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle->TrackedDeployable->ConstructionRigT**  
  
**Supported Animations:**  
* deploy
  
**Description:**  
Construction Rig (Tracked) are a Tracked version of the ConstructionRig. They support all the properties of a ConstructionRig except HoverRig.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 26 // TEAM\_SLOT\_CONSTRUCT needPilot = false \[CraftClass\] canRescue = false

  
**Recommended AI Process:**  

aiName = "RigTFriend" aiName2 = "RigTEnemy"

  
**ODF Properties:**  
* **\[ConstructionRigClass\]**  
    
soundBuild = ""  
Sound file played while building.  
    
soundFinish = ""  
Sound file played when building finishes.  
    
ChromeEffect = false  
If true, builds using Chrome method. Default is true for Race f.  
    
ChromeTexture = ""  
Environment texture applied to Chrome effect. Default is the world's environment texture.  
    
BuildSparkConfig = "sparker"  
Render name for the Build effect. Only used if ChromeEffect is false.  
    
LineStartColor = "0 127 255 255"  
Starting color for Build effect's Extrude lines.  
    
LineFinishColor = "0 0 255 0"  
Finish color for Build effect's Extrude lines.  
    
BeamColor = "0 127 255 31"  
Color for Build effect's beams that go from hp\_special on constructor object to Extrude lines)  
    
lineSolidColor = "0 63 255 127"  
LOD line Color for Build effect.  
    
SolidColorDistance = 150.0f  
LOD distance for Build effect's Extrude to switch to lineSolidColor.  
    
MaxLineDistance = 250.0f  
Max distance for Build effect's Extrude efffect.  
    
buildItem1 ... buildItem10 = ""  
The ODF name to build. If no BuildGroup is specified, it uses these as the top level build items.
  
For each Build Group...  
  
* **\[BuildGroup\]** ... **\[BuildGroup\]**  
    
buildLabel = ""  
The name for this BuildGroup displayed in the Command Panel window.  
    
buildItem1 ... buildItem10 = ""  
The ODF name to build.

 DayWreckerClass 

 Classlabel: "daywrecker"  
  
**Class Tree: Entity->GameObject->PowerUp->DayWrecker**  
  
**Description:**  
DayWrecker is a Powerup object that explodes when it lands.  
  
**ODF Properties:**  
* **\[DayWreckerClass\]**  
    
xplBlast = ""  
Explosion used when this object lands.
  
 DeployableClass 

 Classlabel: "deployable"  
  
**Class Tree: Entitiy->GameObject->Craft->HoverCraft->Deployable**  
  
**Supported Animations:**  
* Deploy
  
**Description:**  
Deployable is a Hover Craft that can Deploy, becoming stationary while deployed. It is a root class for several Deployables, like a TurretTank or Artillery.  
  
**ODF Properties:**  
* **\[DeployableClass\]**  
    
heightDeploy = 0.0f  
Height above Terrain that it deploys to.  
    
timeDeploy = 5.0f  
Time in seconds it takes to Deploy.  
    
timeUndeploy = 5.0f  
Time in seconds it takes to Undeploy.  
    
soundDeploy = "trdeploy.wav"  
Sound file played when this object Deploys.  
    
soundUndeploy = "trundepl.wav"  
Sound file played when this object Undeploys.  
    
isStealthDeployed = false  
If true, this object is hidden from Radar / Target if line of sight is blocked. Default is true for Class: TurretTank.  
    
idleAttackBuildings = -1  
This is used by the AIP when it sends a Deployable out by Idle Dispatcher to attack a Building. Valid values: -1 = auto, 0 = Force Undeployed, 1 = Force Deployed.  
    
idleAttackCraft = -1  
This is used by the AIP when it sends a Deployable out by Idle Dispatcher to attack a Craft. Valid values: -1 = auto, 0 = Force Undeployed, 1 = Force Deployed.  
    
canAttackWhenDeployed = true  
If false, cannot fire weapons while Deployed.  
    
canAttackWhenUndeployed = true  
If false, cannot fire weapons while Undeployed. Default is false for Class: TurretTank.  
    
ScanTeamLimitDeployed = 0  
Sets the scanTeamLimit for this object while it is Deployed.  
    
DeployAtAltitude = true  
If this object deploys at it's setAltitude, or sinks into ground. Used by Class: DeployBuildingH, ScavengerH.  
_Note:_ This value was formerly named "HoverScavDeployAtAltitude" and that Parameter is also read, but it is overridden by DeployAtAltitude if both are present.  
    
SinkOnDeploy = true  
If false, it won't change altitude to heightDeploy, and will stay at it's current height when Deployed.

 DeployBuildingClass 

 Classlabel: "deploybuilding"  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle->TrackedDelpoyable->DeployBuilding**  
  
**Description:**  
This is a Tracked vehicle that can deploy at a location to construct a Building. The Building is constructed after the Deploy animation finishes, and replaces this object's Handle.  
  
**Default ODF Properties:**  

\[GameObjectClass\] needPilot = false \[CraftClass\] canRescue = false

  
**Recommended AI Process:**  

aiName = "DeployBuildingFriend" aiName2 = "DeployBuildingEnemy"

  
**ODF Properties:**  
* **\[DeployBuildingClass\]**  
    
deployName = ""  
The ODF name of the object this Deploys into. Must be a GameObject Class.  
    
ChromeEffect = false  
If true, builds using Chrome method. Default is true for Race f.  
    
ChromeTexture = ""  
Environment texture applied to Chrome effect. Default is the world's environment texture.  
    
BuildSparkConfig = "sparker"  
Render name for the Build effect. Only used if ChromeEffect is false.  
    
LineStartColor = "0 127 255 255"  
Starting color for Build effect's Extrude lines.  
    
LineFinishColor = "0 0 255 0"  
Finish color for Build effect's Extrude lines.  
    
BeamColor = "0 127 255 31"  
Color for Build effect's beams that go from hp\_special on constructor object to Extrude lines)  
    
lineSolidColor = "0 63 255 127"  
LOD line Color for Build effect.  
    
SolidColorDistance = 150.0f  
LOD distance for Build effect's Extrude to switch to lineSolidColor.  
    
MaxLineDistance = 250.0f  
Max distance for Build effect's Extrude efffect.  
    
CanDeploy = true  
If false, cannot Deploy into a Building.  
    
DoExtraBuildzoneCheck = true  
If false, won't check that the buildZone is clear before Deploying there.

 DeployBuildingHClass 

 Classlabel: "deploybuildingH"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Delpoyable->DeployBuildingH**  
  
**Description:**  
This is a HoverCraft vehicle that can deploy at a location to construct a Building. The Building is constructed after the Deploy animation finishes, and replaces this object's Handle.  
  
**Default ODF Properties:**  

\[GameObjectClass\] needPilot = false \[CraftClass\] canRescue = false

  
**Recommended AI Process:**  

aiName = "DeployBuildingHFriend" aiName2 = "DeployBuildingHEnemy"

  
**ODF Properties:**  
* **\[DeployBuildingHClass\]**  
    
deployName = ""  
The ODF name of the object this Deploys into. Must be a GameObject Class.  
    
ChromeEffect = false  
If true, builds using Chrome method. Default is true for Race f.  
    
ChromeTexture = ""  
Environment texture applied to Chrome effect. Default is the world's environment texture.  
    
BuildSparkConfig = "sparker"  
Render name for the Build effect. Only used if ChromeEffect is false.  
    
LineStartColor = "0 127 255 255"  
Starting color for Build effect's Extrude lines.  
    
LineFinishColor = "0 0 255 0"  
Finish color for Build effect's Extrude lines.  
    
BeamColor = "0 127 255 31"  
Color for Build effect's beams that go from hp\_special on constructor object to Extrude lines)  
    
lineSolidColor = "0 63 255 127"  
LOD line Color for Build effect.  
    
SolidColorDistance = 150.0f  
LOD distance for Build effect's Extrude to switch to lineSolidColor.  
    
MaxLineDistance = 250.0f  
Max distance for Build effect's Extrude efffect.  
    
CanDeploy = true  
If false, cannot Deploy into a Building.  
    
DoExtraBuildzoneCheck = true  
If false, won't check that the buildZone is clear before Deploying there.

 DepositClass 

 Classlabel: "deposit"  
  
**Class Tree: Entity->GameObject->Building->Deposit**  
  
**Description:**  
This is a building that is compatible for being Deployed on by a Scavenger or ScavengerH. For instance: Scrap Pools.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canDetect = true canInteract = true buildRequire = "N" buildSupport = "N"

  
**ODF Properties:**  
* **\[DepositClass\]**  
    
DepositClassMask = 0  
Bit Mask for what kind of \[ScavengerClass\] or \[ScavengerHClass\]:: ScavClassMatch and ScavClassProvides to filter what kind of Scavenger/ScavengerH can Deploy on this object.  
    
DepositClassMatch = 0  
Bit Mask for what kind of \[ScavengerClass\] or \[ScavengerHClass\]:: ScavClassMask and ScavClassProvides to filter what kind of Scavenger/ScavengerH can Deploy on this object.  
    
DepositClassProvides = 0  
Bit Mask for what kind of Mask this object Provides for comparison against \[ScavengerClass\] or \[ScavengerHClass\]:: ScavClassMask and ScavClassMatch to filter what kind of Scavenger/ScavengerH can Deploy on this object.

 DummyClass 

 Classlabel: "terrain" or "computer" or "Cnozzle"  
  
**Class Tree: Entity->GameObject->Dummy**  
_Note: Cnozzle is: Entity->GameObject->Building\[i/\]_ 
  
_**Description:**_ 
_Dummy Class is a common class for simple Buildings and Terrain replacing objects._ 
  
_**Default ODF Properties:**_ 

_\[GameObjectClass\] hitType = 1 // HIT\_TYPE\_GROUND isTerrain = true canDetect = false canInteract = false_

  
_**ODF Properties:**_ 
_* **\[BuildingClass\]**_ 
    
_justTerrain = false_ 
_If true, Pathing includes just the Terrain under this object._ 
    
_justFlat = false_ 
_If true, Pathing is made completely flat under this object._
  
  
_Computer Class is a simple Building, that has a very specific settings. It is used for the CORE final room with Nozzles attached similar to Taps, and the Shield with an Animated Texture. The Shield piece has specific model requirements._ 
  
_* **\[ComputerClass\]**_ 
    
_harpoint1 = ""_ 
_Model piece name of the location where a NozzleOdf is attached._ 
    
_harpoint2 = ""_ 
_Model piece name of the location where a NozzleOdf is attached._ 
    
_NozzleOdf = ""_ 
_ODF name of the object to spawn at hardpoint1 and hardpoint2\. Must be a GameObject Class._ 
    
_Shield = ""_ 
_Mdoel piece name for the Shield Object. This piece has it's texture Animated. It must be 4 Vertical verts by 6 Horizontal verts._ 
    
_ShieldVel = 0.0f_ 
_Shield Texture Velocity_ 
    
_ShieldAmp = 0.0f_ 
_Shield Texture Amplitude._ 
    
_beamname = ""_ 
_For Classlabel "CNozzle" Only. Name of the piece that has spinning Animated texture, similar to a light cone._

 ExtractorClass 

 Classlabel: "extractor"  
  
**Class Tree: Entity->GameObject->Building->Extractor**  
  
**Supported Animations:**  
* Deploy
  
**Description:**  
Extractor is a type of Building that is capable of generating Scrap.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 17 // TEAM\_SLOT\_EXTRACTOR buildSupport = "N" \[BuildingClass\] collapseTime = 0.0f

  
**ODF Properties:**  
* **\[ExtractorClass\]**  
    
initDelay = 10.0f  
Time, in seconds, before this object starts to generate Scrap.  
_Note:_ If the Scrap Bar reaches this Extractor's Scrap Segment before this timer is up, it will wait unil this timer expires before generating more Scrap.  
    
scrapDelay = = 10.0f  
The interval, in seconds, between producing 1 Scrap.  
    
scrapHold = 10  
Amount of Scrap storage this object adds to the Scrap Bar.  
    
detectRange = 100.0f  
Radius for this object's Detection range. Revels Enemies on Radar within this range.  
    
ScrapDropPoint = true  
If this is true, Scavenger and ScavengerH with doDrop set to true can Dropoff scrap here.  
    
RunParallel = false  
If this is true, Scrap is generated in parallel for this object, instead of in Scrap Bar sequence.

 FactoryClass 

 Classlabel: "factory"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->Factory**  
  
**Description:**  
Factory Class is a Building that can construct other objects.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 2 // TEAM\_SLOT\_FACTORY isSingle = true

  
**Recommended AI Process:**  

aiName = "BuildingProcess" aiName2 = "BuildingProcess"

  
**ODF Properties:**  
* **\[FactoryClass\]**  
    
soundBuild = ""  
Sound played while building something.  
    
soundCancel = ""  
Sound played when something under construction is cancelled.  
    
soundFinish = ""  
Sound played when something under construction is finished.  
    
selectUser1Msg = ""  
Selection Message of the object while it is Building something.  
    
selectUser2Msg = ""  
Selection Message of the object while it is Unable to build something, such as No Power.  
    
reloadMsg = ""  
Message given when the object is ordered to Build something.  
    
rescueMsg = ""  
Message given when the object is finished Building something.  
    
ChromeEffect = false  
If true, builds using Chrome method. Default is true for Race f.  
    
ChromeTexture = ""  
Environment texture applied to Chrome effect. Default is the world's environment texture.  
    
BuildSparkConfig = "sparker"  
Render name for the Build effect. Only used if ChromeEffect is false.  
    
LineStartColor = "0 127 255 255"  
Starting color for Build effect's Extrude lines.  
    
LineFinishColor = "0 0 255 0"  
Finish color for Build effect's Extrude lines.  
    
BeamColor = "0 127 255 31"  
Color for Build effect's beams that go from hp\_special on constructor object to Extrude lines)  
    
lineSolidColor = "0 63 255 127"  
LOD line Color for Build effect.  
    
SolidColorDistance = 150.0f  
LOD distance for Build effect's Extrude to switch to lineSolidColor.  
    
MaxLineDistance = 250.0f  
Max distance for Build effect's Extrude efffect.  
    
BaseSlot = 2  
If this is specified, it is the Team Slot this object takes up. Valid values are 2-9.  
    
scaleVelY = 0.0f  
Multiplier on vertical launch velocity.  
    
MultVelX = 1.0f  
Multiplier on the X axis KickOut velocity applied to the Craft when it is completed.  
    
MultVelZ = 1.0f  
Multiplier on the Z axis KickOut velocity applied to the Craft when it is completed.  
    
MultVelXZ = 1.0f  
Multiplier on the both the X and Z axis KickOut velocity applied to the Craft when it is completed.  
_Note:_ If MultVelX or MultVelZ is specified, it overrides this setting for that Axis.  
    
KickAllCraft = true  
If this is False, it won't apply a KickOut velocity to the craft.  
    
DropoffDX = 0.0f  
Default Dropoff location X distance.  
_Note:_ This is based off the location of the hp\_vehicle in the model.  
    
DropoffDZ = 32.0f  
Default Dropoff location Z distance.  
_Note:_ This is based off the location of the hp\_vehicle in the model.  
    
DropoffConfig = ""  
If this is specified, overrides the Dropoff ODF dropped by this object. If invalid, it ignores the setting.  
    
WeaponConfig = ""  
If this is specified, it is used as a custom Weapon ODF. If not specified, defaults to Race's \*weapon.odf.  
_Note:_ Must end in .odf, e.g. "iweapon.odf"  
    
buildItem1 ... buildItem10 = ""  
The ODF name to build. If no BuildGroup is specified, it uses these as the top level build items.  
    
buildEmptyItem1 ... buildEmptyItem10 = 0  
If this is specified, the buildItem# that is built with out a Pilot inside it.  
    
buildEmptyItem = 0  
If this is specified, the buildItem# that is built with out a Pilot inside it. If this is a valid BuildGroup, it does it for the whole BuildGroup.
  
For each Build Group...  
  
* **\[BuildGroup\]** ... **\[BuildGroup\]**  
    
buildLabel = ""  
The name for this BuildGroup displayed in the Command Panel window.  
    
buildItem1 ... buildItem10 = ""  
The ODF name to build.  
    
buildEmptyItem1 ... buildEmptyItem10 = 0  
If this is specified, the buildItem# that is built with out a Pilot inside it.

 FlagObjectClass 

 Classlabel: "flag"  
  
**Class Tree: Entity->GameObject->PowerUp->FlagObject**  
  
**Supported Animations:**  
* wave
  
**Description:**  
Flag Object is a type of Powerup that is used for CTF game mode. It gives 20 score when Captured.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canCollide = true boxCollide = true

 HoverCraftClass 

 Classlabel: "hover"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft**  
  
**Supported Animations:**  
* Forward
* Neutral
* Reverse
  
**Description:**  
Hovercraft is a type of Craft that hovers. It usually has standard physics but a few special cases override these physics. Most ships in the game are derived from HoverCraft.  
  
**Default ODF Properties:**  

\[CraftClass\] SitAttackAllowCounterattack = true

  
**ODF Properties:**  
* **\[HoverCraftClass\]**  
    
setAltitude = 1.0f  
Height above Ground that it tries to maintain. Default is 3.0 for Class: ConstructionRig.  
    
accelDragStop = 4.0f  
Maximum Drag from friction. (m/s^2)  
    
alphaDamp = 3.0f  
Pitch/Roll Damping.  
    
alphaTrack = 10.0f  
Terrain tracking torque  
    
pitchPitch = 0.3f  
Pitch angle from Pitch Control. How far the object tilts from Piching up/down. Default is 0.0 for Class: AssaultHover.  
    
pitchThrust = 0.1f  
Pitch angle while Thrusting. Same as pitchPitch but applies while moving.  
    
rollStrafe = 0.1f  
Roll angle while Strafing.  
    
rollSteer = 0.1f  
Roll angle while Steering.  
    
aiAccelDrag = 0.0f  
Similar to AccelDragStop but only applied to AI craft.  
    
velocForward = 20.0f  
Maximum forward velocity from Thrusting.  
    
velocReverse = 10.0f  
Maximum reverse velocity from Thrusting.  
    
velocStrafe = 15.0f  
Maximum strafe velocity from Thrusting.  
    
accelThrust = 25.0f  
Acceleration rate when Thrusting.  
    
accelBrake = 75.0f  
Acceleration rate when Braking.  
    
omegaSpin = 4.0f  
Turn rate while stationary.  
    
omegaTurn = 1.5f  
Turn rate while Thrusting.  
    
alphaSteer = 5.0f  
Maximum steering Acceleration rate.  
    
accelJump = 0.1f  
Maximum Jumping life velocity.  
    
accelDragEmpty = 30.0f  
Acceleration Drag when not Piloted.  
    
alphaDampEmpty = 5.0f  
Pitch/Roll Damping when not Piloted.  
    
alphaTrackEmpty = 15.0f  
Terrain tracking torque when not Piloted.  
    
soundThrust = "engthrst.wav"  
Sound file played when engine thrust is applied. Plays when thrust is applied. Rate increases with Thrust.  
    
soundFly = "amb\_wind.wav"  
Sound file that plays while this craft is Airborne. Volume changes with height when near the ground.  
    
soundJump = ""  
If specified, this is the sound file that plays while the Jump control is pressed.  
    
ScaleDampWithThrust = true  
If this is false, alpha dampening will be constant, and won't reduce with Thrust when Airborne.  
    
MoreLike12Physics = false  
If this is true, it uses a physics set that is closer to Original version 1.2 code style.  
    
FlyingPhysics = false  
If this is true, it uses Flying physics similar to APC/Bomber/Artillary/SAV.  
    
THRUST\_PITCH\_BASE = 11025.0f  
Base Rate applied to soundThrust.  
    
THRUST\_PITCH\_RANGE = 5000.0f  
Maximum range THRUST\_PITCH\_BASE can change.  
    
THRUST\_VOLUME\_BASE\_USER = 0.4f  
Base Volume for soundThrust for Player piloted Craft.  
    
THRUST\_VOLUME\_RANGE\_USER = 0.4f  
Maximum range THRUST\_VOLUME\_RANGE\_USER can change.  
    
THRUST\_VOLUME\_BASE\_AI = 0.4f  
Base Volume for soundThrust for AI piloted Craft.  
    
THRUST\_VOLUME\_RANGE\_AI = 0.4f  
Maximum range THRUST\_VOLUME\_BASE\_AI can change.  
    
LIFT\_SPRING = 25.0f  
Lift Spring.  
    
LIFT\_DAMP = 6.25f  
Life Dampening.  
    
LIFT\_SPRING\_EMPTY = 3.0f  
Lift Spring when not Piloted.  
    
LIFT\_DAMP\_EMPTY = 2.0f  
Life Dampening when not Piloted.  
    
**Physics for over Land, Water, and Airborne:**  
    
OverLandVelocFrontMult = 1.0f  
Forward Velocity multiplier while on Land.  
    
OverLandVelocSideMult = 1.0f  
Strafe Velocity multiplier while on Land.  
    
OverLandThrottleMult = 1.0f  
Thrust multiplier while on Land.  
    
OverWaterVelocFrontMult = 0.75f;  
Forward Velocity multiplier while on Water.  
    
OverWaterVelocSideMult = 0.75f;  
Strafe Velocity multiplier while on Water.  
    
OverWaterThrottleMult = 0.8f;  
Thrust multiplier while on Water.  
    
AirborneVelocFrontMult = 1.0f;  
Forward Velocity multiplier while Airborne.  
    
AirborneVelocSideMult = 1.0f;  
Strafe Velocity multiplier while Airborne.  
    
AirborneThrottleMult = 1.0f;  
Thrust multiplier while on Airborne.  
    
AirborneMinHeightRatio = 2.0f;  
Modifier used with setAltitude for when to use OverLand or OverWater speed and throttle multipliers.  
    
AirborneMaxHeightRatio = 5.0f;  
Modifier used with setAltitude for when to use Airborne speed and throttle multipliers.  
    
DeployedOverLandVelocFrontMult = 1.0f;  
Forward Velocity multiplier while on Land when Deployed.  
    
DeployedOverLandVelocSideMult = 1.0f;  
Strafe Velocity multiplier while on Land when Deployed.  
    
DeployedOverLandThrottleMult = 1.0f;  
Thrust multiplier while on Land when Deployed.  
    
DeployedOverWaterVelocFrontMult = 0.75f;  
Forward Velocity multiplier while on Water when Deployed.  
    
DeployedOverWaterVelocSideMult = 0.75f;  
Strafe Velocity multiplier while on Water when Deployed.  
    
DeployedOverWaterThrottleMult = 0.8f;  
Thrust multiplier while on Water when Deployed.  
    
DeployedAirborneVelocFrontMult = 1.0f;  
Forward Velocity multiplier while Airborne when Deployed.  
    
DeployedAirborneVelocSideMult = 1.0f;  
Strafe Velocity multiplier while Airborne when Deployed.  
    
DeployedAirborneThrottleMult = 1.0f;  
Thrust multiplier while Airborne when Deployed.  
    
DeployedAirborneMinHeightRatio = 2.0f;  
Modifier used with setAltitude for when to use OverLand or OverWater speed and throttle multipliers when Deployed.  
    
DeployedAirborneMaxHeightRatio = 5.0f;  
Modifier used with setAltitude for when to use Airborne speed and throttle multipliers when Deployed.  
    
UseWaterHeight = true  
If setAltitude uses height over Water, or only height over Terrain.  
    
DeployedUseWaterHeight = true  
Same as useWaterHeight but only applies during Deployed state.  
    
terrainLookaheadTime = 0.5f  
Time in seconds to look ahead for Terrain to adjust Altitude accordingly.  
    
heightLookaheadTime = 0.05f  
How much to adjust the Terrain height value by velocity to reduce ground impacts.  
    
flattenTrackNormal = 1.0f  
The amount to add to the Y component of the Terrain Normal to flatten it out (higher is flatter).  
    
minThrustRatio = 0.5f  
Minimum Thrust scale unit gets while fully airborne for "air control"  
    
minThrustReduce = 0.0f  
Minimum Thrust scale the unit gets when anti-flying thrust reduction is in effect.  
    
offsetDownwardThrust = 1.0f  
The fraction of Thrust into the ground to offset.

 HowitzerClass 

 Classlabel: "howitzer"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Deployable->TurretTank->Howitzer**  
  
Howitzer is a version of TurretTank that cannot issue an Attack order unless it is Deployed.  
  
**Default ODF Properties:**  

categoryTypeOverride = 23 // TEAM\_SLOT\_DEFENSE

 JammerClass 

 Classlabel: "jammer"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->Jammer**  
  
**Description:**  
Jammer is an object that Jams the Radar of nearby Craft.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 18 // TEAM\_SLOT\_JAMMER buildRequire = "N" buildSupport = "N"

  
**ODF Properties:**  
* **\[JammerTowerClass\]**  
    
jammerRange = 100.0f  
Range of the Jamming effect  
    
DampTeamFilter = 2  
Team Filter for Damping. This controls which Teams it hides. Values are: 0 = All Teams, 1 = Same Team only, 2 = Allies, 3 = Enemies, 4 = Not Same Team.  
    
JamScannerTeamFilter = 3  
Team Filter for Jamming. This controls which Teams are Jammed. Values are: 0 = All Teams, 1 = Same Team only, 2 = Allies, 3 = Enemies, 4 = Not Same Team.

 KingOfHillClass 

 Classlabel: "kingofhill"  
  
**Class Tree: Entity->GameObject->Building->KingOfHill**  
  
**Description:**  
KindOfHill is the object that is used for King of the Hill game mode. It is always Hidden in non-Editor mode, similar to SpawnBouy.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canDetect = false canInteract = false canCollide = false canSnipe = false isAssault = false

  
**ODF Properties:**  
* **\[KingOfHillClass\]**  
    
scoreRadius = 10.0f  
Amount of Score given.  
    
scoreDelay = 1.0f  
Interval between giving Score.

 LandCreatureClass 

 Classlabel: "animal"  
  
**Class Tree: Entity->GameObject->Craft->LandCreature**  
  
**Supported Animations:**  
* Idle
* Idle2
* Idle3
* Curious
* Walk
* Run
* Attack1
* Attack2
* Attack3
* Attack4
* Eat1
* Eat2
  
**Description:**  
LandCreature class is most similar to PersonClass, but differs mostly in AI behavior.  
  
**Default ODF Properties:**  

\[GameObjectClass\] hitType = 2 // HIT\_TYPE\_PERSON

  
Recommended AI Process:  

aiName = "LandAnimalProcess"

  
**ODF Properties:**  
* **\[LandCreature\]**  
    
velocJump = 10.0f  
Jump Velocity.  
    
alphaTrack = 20.0f  
Alpha Traction.  
    
alphaDamp = 5.0f  
Alpha Damping.  
    
accelThrust = 0.7f  
Acceleration Multiplier. Maximum is 1.0\. It is used as a modified along with Gravity on VelocForward to calculate Acceleration.  
    
velocForward = 5.0f  
Maximum forward velocity from Thrust.  
    
alphaSteer = 2.0f  
Steering Acceleration.  
    
omegaSpin = 10.0f  
Turning speed while standing still.  
    
omegaTurn = 20.0f  
Turning speed while moving.  
    
GroundInteractHeight = 0.2f  
Height tolerance from Ground to be considered not Airborne.  
    
TooFarDist = 5.5f  
How far it's Target has to be before it stops Attacking and switches to Goto.  
    
DamageBase = 100.0f  
Base Damage done per Attack.  
    
DamageArmor = 1.0f  
Damage Multiplier for Armor.  
    
DamageShield = 1.0f  
Damage Multiplier for Shield.  
    
DamageValue = 100.0f  
Damage value per Attack.  
    
jumpSound = "jump.wav"  
Sound file played when this object Jumps.  
    
landSound = "land.wav"  
    
stepSound = "step.wav"  
    
splashSound = "splash.wav"  
    
painSound1 ... painSound6 = ""  
Sound file played when this object is Shot.  
    
burnSound1 ... burnSound2  
Sound file played when this object is in Water Damage.  
    
dieSound1 ... dieSound5  
Sound file played when this object dies.  
    
curiousSound1 ... curiousSound4  
Sound file played when this object detects a nearby Target.  
    
eatSound1 ... eatSound4  
Sound file played when this object Attacks.  
    
crushSound = ""  
If specified, this is the sound file played when this object dies from Collision.  
    
leftfootpiece = "lfoot"  
Model piece name for the Left Foot.  
    
rightfootpiece = "rfoot"  
Model piece name for the Right Foot.

 LightClass 

 Classlabel: "pointlight" or "directionlight" or "spotlight"  
  
**Description:**  
Light Class is a special class that is isolated from the rest. It is closer to a RenderClass then an actual Object. These can only be used in \[GameObjectClass\]::lightName#.  
  
**ODF Properties:**  
* **\[LightClass\]**  
    
lightColor.r = 1.0f  
Light Red Color.  
    
lightColor.g = 1.0f  
Light Green Color.  
    
lightColor.b = 1.0f  
Light Blue Color.  
    
lightColor.a = 1.0f  
Light Alpha Color.  
    
lightRange = 1e15  
Maximum range of the Light.  
    
Light Attenuation values. Use this graph to calculate the desired settings with BZCC's Shader:  
Battlezone Combat Commander Light Attenuation Graph\[www.desmos.com\]  
R = Radius, Kc = Constant, Kl = Linear, Kq = Quadratic. The Blue line represents BZCC's light falloff. BZCC's Shader forces the light to end at 0, which is why the dotted Red line isn't the actual light falloff curve.  
    
    
attenuateConstant = 1.0f  
Constant Attenuation, modified by Liniar/Quadratic.  
    
attenuateLinear = 0.0f  
Liniar Attenuation.  
    
attenuateQuadratic = 15.0f  
Quadratic Attenuation.  
    
coneAngInner = 1.570795  
Inner Cone Angle for Class: Spotlight.  
    
coneAngOuter = 1.570795  
Outer Cone Angle for Class: Spotlight.  
    
coneFalloff = 1.0f  
Cone Falloff ratio between origin and Radius. Used for Class: Spotlight.  
    
lensFlare = true  
If false, doesn't create a Sprite of "lightflare.tga" at it's origin.

 MineClass 

 Classlabel: "mine"  
  
**Class Tree: Entity->GameObject->Building->Mine**  
  
**Description:**  
Mine is a simple Building that detonates.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canCollide = true boxCollide = true maxHealth = 150

  
**ODF Properties:**  
* **\[MineClass\]**  
    
lifeSpan = 60.0f  
Time in seconds until this mine expires.  
    
xplBlast = ""  
ODF name of the Explosion Class used if this mine Detonates.  
    
detonateExpire = false  
If this is true, it will use xplBlast when it dies from lifeSpan expiring.

 FlareMineClass 

 Classlabel: "flare"  
  
**Class Tree: Entity->GameObject->Building->Mine->FlareMine**  
  
**Description:**  
Flare Mine is a Mine that fires an Ordnance and emits a Damage field and Kick effect.  
  
**Default ODF Properties:**  

\[MineClass\] lifeSpan = 60.0f

  
**ODF Properties:**  
* **\[FlareMineClass\]**  
    
payloadName = ""  
ODF name of the Ordnance class this mine fires.  
    
fireSound = ""  
Sound file played when this mine fires it's ordnance.  
    
triggerDelay = 0.0f  
Time in seconds before it starts emitting ordnance/damage.  
    
shotDelay = 0.05f  
Time in seconds between shooting it's payloadName.  
    
shotVariance = 0.5f  
Shot Variance for the ordnance.  
    
damageRadius = 0.0f  
Radius that Damage is applied near this object.  
    
damageValue(N) = 0  
Damage value done to objects with no Shield and Armor class N.  
    
damageValue(L) = 0  
Damage value done to objects with no Shield and Armor class L.  
    
damageValue(H) = 0  
Damage value done to objects with no Shield and Armor class H.  
    
damageValue(S) = 0  
Damage value done to objects with Shield class S.  
    
damageValue(D) = 0  
Damage value done to objects with Shield class D.  
    
damageValue(A) = 0  
Damage value done to objects with Shield class A.  
    
kickRadius = 0.0f  
Radius that Kick effect is applied.  
    
kickVeloc = 0.0f  
Kick Velocity applied to objects nearby.  
    
kickOmega = 0.0f  
Kick Omega applied to objects nearby.  
    
TeamFilter = 0  
Team Filter for what objects the Flare Mine can Damage. Valid values: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies, 4 = not same team

 MagnetMineClass 

 Classlabel: "magnet"  
  
**Class Tree: Entity->GameObject->Building->Mine->MagnetMine**  
  
**Description:**  
Magnet Mine class is a Mine that has a Magnet Field.  
  
**Default ODF Properties:**  

\[MineClass\] lifeSpan = 60.0f

  
**ODF Properties:**  
* **\[MagnetMineClass\]**  
    
fireSound = ""  
Sound file played when this mine fires it's ordnance.  
    
triggerDelay = 1.0f  
Time in seconds before it starts emitting ordnance/damage.  
    
fieldRadius = 20.0f  
How far the field extends outward.  
    
objPushCenter = 30.0f  
Object push force at Center of field.  
    
objPushEdge = 3.0f  
Object push force at Edge of field.  
    
objDragCenter = 0.0f  
Object Drag at Center of field.  
    
objDragEdge = 0.0f  
Object Drag at Edge of field.  
    
objDrag = ObjDragCenter.  
If this is set, it is used for both objDragCenter and objDragEdge, and overrides those settings.  
    
ordPushCenter = 100.0f  
Ordnance push force at Center of field.  
    
ordPushEdge = 10.0f  
Ordnance push force at Edge of field.  
    
ordDragCenter = 0.0f  
Ordnance Drag at Center of field.  
    
ordDragEdge = 0.0f  
Ordnance Drag at Edge of field.  
    
ordDrag = OrdDragCenter.  
If this is set, it is used for both ordDragCenter and ordDragEdge , and overrides those settings.  
    
TeamFilter = 0  
Team Filter for what Teams to affect. Valid values are: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies  
    
ForceMass = -1  
If this is < 0, default behavior is applied. If this is > 0, then the Force applied to the object is multiplied by (ForceMass / Target's Mass).  
    
MinForceMassScale = 0.0001  
If ForceMass is > 0, this is the minimum mass it clamps to.  
    
MaxForceMassScale = 1.0  
If ForceMass is > 0, this is the maximum mass it clamps to.

 ProximityMineClass 

 Classlabel: "proximity"  
  
**Class Tree: Entity->GameObject->Building->Mine->ProximityMine**  
  
**Description:**  
Proximity Mine is a type of mine that Detonates when an enemy gets close to it.  
  
**Default ODF Properties:**  

\[MineClass\] lifeSpan = 1e30

  
**ODF Properties:**  
* **\[ProximityMineClass\]**  
    
triggerRadius = 20.0f  
Radius at which an Enemy will trigger the mine to Detonate.  
    
suppressRadius = 50.0f  
Radius which it will not Detonate if a friendly unit is within.

 TripMineClass 

 Classlabel: "tripmine"  
  
**Class Tree: Entity->GameObject->Building->Mine->TripMine**  
  
**Description:**  
Trip Mine is a Mine that works similar to ProximityMine, except when an Enemy gets close enough, instead of Detonating, it swaps itself with another GameObject Class.  
  
**Default ODF Properties:**  

\[MineClass\] lifeSpan = 1e30

  
**ODF Properties:**  
* **\[TripMineClass\]**  
    
triggerRadius = 20.0f  
Radius at which an Enemy will trigger the mine.  
    
suppressRadius = 50.0f  
Radius which it will not trigger if a friendly unit is within.  
    
payloadName = ""  
ODF of the GameObject Class this turns into when Triggered.  
    
TeamFilter = 0  
Team Filter for this object. Valid values are: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies, 4 = not same team  
    
fireSound = ""  
Sound file played when this mine is Triggered.

 WeaponMineClass 

 Classlabel: "weaponmine"  
  
**Class Tree: Entity->GameObject->Building->Mine->WeaponMine**  
  
**Description:**  
Weapon Mine is a Mine that can shoot a WeaponClass at a nearby Target.  
  
**Default ODF Properties:**  

\[GameObjectClass\] maxHealth = 1000 \[MineClass\] lifeSpan = 1e30
  
  
**ODF Properties:**  
* **\[WeaponMineClass\]**  
    
searchRadius = 50.0f  
Radius the Weapon Mine will search for Targets.  
    
heightScale = 10.0f  
Height which the ordnance emits from.  
    
TargetHidden = -1  
If this is >= 0, it is used to check if the Weapon Mine targets MorphTanks with HiddenWhenMorphed while Deployed. 0 is false, 1 is true.  
    
TargetInteractable = -1  
If this is >= 0, it is used to check if the Weapon Mine targets objects that are Interactable. 0 is false, 1 is true.  
    
TeamFilter = 0  
Team Filter for what objects the Weapon Mine can Target. Valid values: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies, 4 = not same team

 SeekerClass 

 Classlabel: "seeker"  
  
**Description:**  
Seeker is a type of GameObject that can drift towards a nearby Target, and Detonates on impact.  
  
**ODF Properties:**  
* **\[SeekerClass\]**  
    
searchRange = 50.0f  
Range which it seeks out Targets.  
    
floatVeloc = 10.0f  
Velocity that it homes in on Targets.  
    
setAltitude = 2.0f  
Altitude above the ground.

 SatchelChargeClass 

 Classlabel: "satchel"  
  
**Class Tree: Entity->GameObject->Building->Mine->SatchelCharge**  
  
**Description:**  
Satchel Charge is a Mine that detonates after a specified time. It can also display a Cockpit Timer count down. Only one Cockpit Timer can be used at a time. Newest one overrides.  
  
**Default ODF Properties:**  

\[MineClass\] detonateExpire = true

  
**ODF Properties:**  
* **\[SatchelChargeClass\]**  
    
UseCockpitTimer = true  
If false, won't display a Cockpit Timer for this object.

 MinelayerClass 

 Classlabel: "minelayer"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Minelayer**  
  
**Description:**  
Minelayers are HoverCraft that can lay Mines in a pattern.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 23 // TEAM\_SLOT\_DEFENSE

  
**Recommended AI Process:**  

aiName = "MineLayerFriend" aiName2 = "MineLayerEnemy"

  
**ODF Properties:**  
* **\[MineLayerClass\]**  
    
mineCount = 15  
The number of Mines to drop for each cycle.  
    
radius = 10.0f  
Starting Radius of mine Pattern.  
    
radiusInc = 10.0f  
Amount Radius increases each Mine. If RingPattern is true, amount it increases each Ring.  
    
angleInc = 90.0f  
How much the initial Angle increment per Mine is.  
    
angleDec = 4.0f  
How much angleInc decreases with each Mine dropped. If RingPattern is false: How much angleInc decreases with each Ring.  
    
timeout = 10.0f  
Time in seconds before it gives up reaching it's next Mine Drop point and drops the mine at it's current location and moves onto next Mine Dropoff point.  
    
ringPattern = false  
If true, it uses BZ1/98R's pattern of rings for laying the Mines. Default is a spiral pattern.

 MoneyPowerupClass 

 Classlabel: "moneybag"  
  
**Class Tree: Entity->GameObject->PowerUp->MoneyPowerup**  
  
**Description:**  
This object is a Powerup that gives Score when picked up by a Person.  
  
**Default ODF Properties:**  

\[PowerUpClass\] soundPickup = "weapon.wav"

  
**ODF Properties:**  
* **\[MoneyPowerupClass\]**  
    
moneyUp = 100  
Amount of Score to give when picked up.

 MorphTankClass 

 Classlabel: "morphtank"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Deployable->MorphTank**  
  
**Supported Animations:**  
* Foward2
* Neutral2
* Reverse2
  
**Description:**  
MorphTank Class is a type of HoverCraft that can Deploy. It reads alternate values for several \[GameObjectClass\] and \[CraftClass\] values under \[MorphTankClass\] which are only used while Deployed. The 2nd set of movement Animations are used while Deployed.  
  
When Deployed, it attempts to use a unitStatus image with the number 2 appended to the end. So for instance, wire\_fvtank is used when Undeployed, and wire\_fvtank2 is used when Deployed.  
  
**Default ODF Properties:**  

categoryTypeOverride = 22 // TEAM\_SLOT\_OFFENSE \[DeployableClass\] timeDeploy = 3.0f timeUndeploy = 3.0f

  
_Note:_ MorphTankClass properties are **NOT** supported by ODF Inheritance.  
  
**ODF Properties:**  
* **\[MorphTankClass\]**  
    
The following values are inherited from their \[GameObjectClass\] versions if not specified:  
maxHealth addHealth maxAmmo addAmmo unitName weaponMask  
    
The following values are inherited from their \[CraftClass\] versions if not specified:  
rangeScan periodScan steerFactor omegaFactor  
    
The following values are inherited from their \[HoverCraftClass\] versions if not specified:  
setAltitude accelDragStop alphaDamp alphaTrack pitchPitch pitchThrust rollStrafe rollSteer velocForward velocReverse velocStrafe accelThrust accelBrake omegaSpin omegaTurn alphaSteer accelJump soundThrust soundFly  
    
unitStatus = ""  
If specified, this is the unitStatus image while Deployed. Overrides default if specified.  
    
switchMask = "11111"  
This is similar to weaponMask, but identifies which weapon hard points switch to Assault mode when Deployed.  
    
MorphedEffectsMask  
EffectMask used while Deployed.  
_Note:_ Mission Scripts can override this setting.  
    
HiddenWhenMorphed = false  
If true, object is Cloaked while Deployed. (Red Field + Phantom VIR + Ignored by AI)  
    
CanObjectifyWhenHidden = true  
If false, Scouts and MotionSensor can't Objectify it while Deployed.  
    
UseChromeMesh = true  
    
Following only used if UseChromeMesh is true:  
    
MorphAmbientR = 1.0f  
Ambient Red Color for Chrome effect while Morphing.  
    
MorphAmbientG = 1.0  
Ambient Green Color for Chrome effect while Morphing.  
    
MorphAmbientB = 1.0  
Ambient Blue Color for Chrome effect while Morphing.  
    
MorphDiffuseR = 1.0  
Diffuse Red Color for Chrome effect while Morphing.  
    
MorphDiffuseG = 1.0  
Diffuse Green Color for Chrome effect while Morphing.  
    
MorphDiffuseB = 1.0  
Diffuse Blue Color for Chrome effect while Morphing.  
    
MorphEmissiveR = 0.0  
Emissive Red Color for Chrome effect while Morphing.  
    
MorphEmissiveG = 0.0  
Emissive Green Color for Chrome effect while Morphing.  
    
MorphEmissiveB = 0.0  
Emissive Blue Color for Chrome effect while Morphing.  
    
MorphSpecularR = 0.0  
Specular Red Color for Chrome effect while Morphing.  
    
MorphSpecularG = 0.0  
Specular Green Color for Chrome effect while Morphing.  
    
MorphSpecularB = 0.0  
Specular Blue Color for Chrome effect while Morphing.  
    
MorphSpecularA = 1.0  
Specular Alpha Color for Chrome effect while Morphing.  
    
MorphSpecularP = 0.0  
Specular Power for Chrome effect while Morphing.  
    
MorphTexture = ""  
Texture filename applied to Chrome effect. If not specified, uses the world's Environment texture.

 MotionSensorClass 

 Classlabel: "sensor"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->MotionSensor**  
  
**Description:**  
MotionSensor class are able to Objectify nearby enemies.  
  
**Default ODF Properties:**  

categoryTypeOverride = 19 // TEAM\_SLOT\_SENSOR buildRequire = "F" buildSupport = "A"

  
**ODF Properties:**  
* **\[MotionSensorClass\]**  
    
rangeScan = 500.0f  
How far it will search for objects to Objectify.  
    
MaxCraft = -1  
Maximum number of Craft it can Objectify.  
    
MaxBuildings = -1  
Maximum number of Buildings it can Objectify.  
    
searchFilter = -1  
Bit Mask for object search for filtering what kinds of objects it can Objectify. Valid values:  
   * 1 = Hovercraft.  
   * 2 = TrackedVehicle / Walker.  
   * 4 = Torpedo.  
   * 8 = Powerup.  
   * 16 = Person.  
   * 32 = LandCreature.  
   * 64 = Building (i76building, Cnozzle)  
   * 128 = PoweredBuilding  
   * 256 = Sign (i76sign, Mine)  
   * 512 = Scrap  
   * 1024 = Deposit  
   * 2048 = Beacon  
   * 4096 = Plant/Bush  
   * 8192 = Terrain

 NavBeaconClass 

 Classlabel: "beacon"  
  
**Class Tree: Entity->GameObject->NavBeacon**  
  
**Description:**  
NavBeacon class is a rally marker type object used for Nav markers around the map.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canCollide = false canInteract = true canSelect = true

 ObjectSpawnClass 

 Classlabel: "objectspawn"  
  
**Class Tree: Entity->GameObject->Building->ObjectSpawn**  
  
**Supported Animations:**  
* Loop
  
**Description:**  
Object Spawner is an object that can spawn another object. It is Hidden when not in the Editor view.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canDetect = false canInteract = false canCollide = false canSnipe = false isAssault = false
  
  
**ODF Properties:**  
* **\[ObjectSpawnClass\]**  
    
spawnName = ""  
The ODF name to spawn. Must be a GameObject Class.  
    
spawnDelay = 30.0f  
The delay before initial Spawn, and the delay before the object respawns once it has died.  
    
spawnSound = "spawn.wav"  
Sound file used when it spawns the object.

 PersonClass 

 Classlabel: "person"  
  
**Class Tree: Entity->GameObject->Craft->Person**  
  
**Supported Animations:**  
* Stand
* Walk
* Crouch
* Jump
* StandC
* WalkC
* CrouchC
* JumpC
* StandA
* WalkA
* CrouchA
* JumpA
* DeathA
* DeathB
* DeathC
  
**Description:**  
Person is a type of Craft that has walking animations, and can enter Vehicles and interact with Terminals. It's also the only Class that can pick up a MoneyBag item.  
  
**Default ODF Properties:**  

\[GameObjectClass\] hitType = 2 // HIT\_TYPE\_PERSON canDetect = false canInteract = false boxCollide = false isGrouped = false needGroup = false isLimited = false needLimit = false canDropScrap = false \[CraftClass\] canInteractWithTerminal = true weaponPitch = 1.0f

  
**Recommended AI Process:**  

aiName = "PersonFriend" aiName2 = "PersonEnemy"

  
**ODF Properties:**  
* **\[PersonClass\]**  
    
autoDeploy = true  
If this is true (default), this object Deploys when selecting a weapon marked as isAssault. If false, doesn't do the usual Deploy stuff.  
    
UseFastTransitions = true  
If this is true, starts Deploying/Undeploying based on weapon Selection. if false, Deploys/Undeploys based on animation finishing.  
    
switchMask = 00000  
Similar to wepaonMask, but sets which weapon hard points switch to Assault Mode when Deployed.  
    
alphaDampCrawl = 5.0f; alphaTrackCrawl = 10.0f; velocForwardCrawl = 0.0f; velocReverseCrawl = 0.0f; velocStrafeCrawl = 0.0f; accelThrustCrawl = 20.0f; omegaSpinCrawl = 0.5f; omegaTurnCrawl = 0.5f; alphaSteerCrawl = 5.0f; velocJumpCrawl = 0.0f; pitchScaleCrawl = 0.5f;  
Physics parameters while Crouched (Deployed) on the ground.  
    
alphaDampRun = 8.0f; alphaTrackRun = 15.0f; velocForwardRun = 4.0f; velocReverseRun = 3.0f; velocStrafeRun = 3.0f; accelThrustRun = 20.0f; omegaSpinRun = 3.0f; omegaTurnRun = 2.0f; alphaSteerRun = 5.0f; velocJumpRun = 5.0f; pitchScaleRun = 1.5f;  
Physics parameters while Walking (Not Deployed) on the ground.  
    
alphaDampFly = 2.0f; alphaTrackFly = 5.0f; velocForwardFly = 15.0f; velocReverseFly = 10.0f; velocStrafeFly = 10.0f; accelThrustFly = 5.0f; omegaSpinFly = 2.0f; omegaTurnFly = 1.5f; alphaSteerFly = 2.0f; velocJumpFly = 0.0f; pitchScaleFly = 1.0f;  
Physics parameters while Airborne.  
    
painSound1 ... painSound6 = "pain1.wav" ... "pain6.wav"  
Sound file played when this object is Shot.  
    
burnSound1 ... burnSound2 = "lburn1.wav" ... "lburn2.wav"  
Sound file played when this object is in Water Damage.  
    
dieSound1 ... dieSound5 = "death1.wav" ... "death5.wav"  
Sound file played when this object dies.  
    
crushSound = "squish.wav"  
Sound file played when this object gets hit with Collision.  
    
jumpSound = "jump.wav"  
Sound file played when this object Jumps.  
    
landSound = "land.wav"  
Sound file played when this object lands.  
    
stepSound = "step.wav"  
Not used.  
    
animRate = 1.0  
Rate which animations play.  
    
IsSingle = false  
If this is true, sets this object's categoryType to 22 (TEAM\_SLOT\_OFFENSE)  
    
SpawnInvincibleTime = 0.5f  
Time, in seconds, that newly created Persons are unable to be Damaged.  
    
PersonMass = 75.0f  
Mass setting for Person. Overrides \[GameObjectClass\] setting if specified.  
    
PersonRadius = 1.0  
Mass's Radius setting, for Person.  
    
DyingTimer = 3.0f  
How long it waits to play animations when this object dies.  
    
PersonClassPilotMask = 0  
Bit Mask for comparing against CraftClassPilotMatch and CraftClassPilotProvides. Used to filter which Pilots can enter a vehicle.  
    
PersonClassPilotMatch = 0  
Bit Mask for comparing against CraftClassPilotMatch and CraftClassPilotProvides. Used to filter which Pilots can enter a vehicle.  
    
PersonClassPilotProvides = 0  
Bit Mask for providing against CraftClassPilotMask and CraftClassPilotMatch. Used to filter which Pilots can enter a vehicle.

 PlantClass 

 Classlabel: "bush" or "plant"  
  
**Class Tree: Entity->GameObject->Building->Plant**  
  
**Description:**  
Plants are classes that can be shot down/driven over, and then re-grow after a period of time.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canDetect = false canInteract = false canCollide = false

  
**ODF Properties:**  
* **\[PlantClass\]**  
    
standUp = false  
If true, forces it to be straight up, otherwise aligns up perpendicular to Terrain.  
    
TransparentGrow = false  
If true, Top of growth is transparent.  
    
TransparentFall = true  
If true, Fall fades to transparent after it falls.  
    
TransparentBurn = true  
If true, top of Burn is transparent.  
    
deadTime = -1  
How long it stays Dead before regrowing.  
    
growTime = 4.0f  
Time in seconds it takes to Grow.  
    
typeOfDeath = 0  
Type of Death used. Valid values are: 0 = None, 1 = Explode, 2 = Fall, 3 = Burn, 4 = Collision Fall & Shot Burn.  
    
fallTime = 4.0f  
Time in seconds it takes to Fall.  
    
burnTime= 20.0f  
Time in seconds it takes to Burn.  
    
hitRadius = -1  
Hit Radius to trigger death. If -1 it uses ObjectSphere Height.  
    
bigFlame = ""  
Flame Effect used for the Burn.  
    
darkRadius = -1  
If this is > 0, the radius it Darkens the ground under it when placed.  
    
darkScale = -1  
Multiplier for how much it darkens the ground under it.  
    
UseExplosionsOnFall = false  
If this is true, it reads and uses the following:  
    
hitGroundName = ""  
ODF name of the Explosion Class used when this plant falls and hits the Ground.  
    
hitByCarName = ""  
ODF name of the Explosion Class used when this plant is hit by a Vehicle.  
    
hitByBulletName = ""  
ODF name of the Explosion Class used when this plant is hit by an Ordnance.  
    
smallFlame = ""  
ODF name of the Explosion Class used to make rings of fire along the tree when it Burns.
  
Bush Class:  
  
* **\[BushClass\]**  
    
SwayingAmp = 5.0f  
Swaying Amplitude.  
    
SwayingFrec = 8.0f  
Swaying Frequency.  
    
SwayingDirX = 1.0  
Swaying Direction on the X Axis.  
    
SwayingDirZ = 1.0  
Swaying Direction on the Z Axis.

 PoweredBuildingClass 

 Classlabel: "powered"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding**  
  
**Supported Animations:**  
* Deploy
  
**Description:**  
Powered buildings default to consuming 1 Power, and support a Deploy animation and Taps.  
  
**Default ODF Properties:**  

\[GameObjectClass\] powerCost = 1 buildRequire = "B" buildSupport = "B"

  
**ODF Properties:**  
* **\[PoweredBuildingClass\]**  
    
powerName = ""  
If specified, this is used as the powerName for all Taps not otherwise specified.  
    
powerTap1 ... powerTap8 = ""  
Model piece name for this Tap object.  
    
powerName1 ... powerName8 = powerName  
The ODF name for each Tap object. Must be a GameObject Class. Default is powerName if not specified.  
    
AutoBuildTap1 ... AutoBuildTap8 = true  
If this is false, it won't automatically spawn the Tap when this object is created.  
    
PoweredByTaps = true  
If this is false, Taps don't count towards this Object's Power Cost.  
    
DestroyTapsWithParent = true  
If this is false, Taps aren't destroyed when this object dies.  
    
detectRange = 200.0f  
Range at which it shows Enemies on Radar.  
    
CanBasepanelSelect = false  
    
PanelIcon = ""  
If specified, this is the icon that is displayed in the Base Panel, if this object occupies a Base 1 - 9 slot.  
    
SoundSelect = ""  
Sound file played when this object is Selected using the Base Panel.  
    
SoundDeselect = ""  
Sound file played when this object is Deselected.  
    
SoundSwitchOn = ""  
Sound file played when this object is switched to Powered On state.  
    
SoundSwitchOff = ""  
Sound file played when this object is switched to Powered Off state.  
    
SoundTerminalSwitchOn = ""  
Sound file played when this object's Terminal is activated.  
    
SoundTerminalSwitchOff = ""  
Sound file played when this object's Terminal is deactivated.  
    
CanAlliesUse = false  
If this is true, Allies can login to the Terminal.  
    
PauseAnimOnUnpowered = true  
If this is true, animations will Pause while this object is Powered Off.  
    
ShowIcon = true  
If this is false, it won't show an Icon.

 PowerPlantClass 

 Classlabel: "powerplant" or "powerlung"  
  
**Class Tree: Entity->GameObject->Building->PowerPlant**  
  
**Supported Animations:**  
* Loop
  
**Description:**  
Power Plants are Buildings that default to a powerCost of -3 for "powerplant" and -1 for "powerlung".  
  
**Default ODF Properties:**  
classlabel: powerplant  

\[GameObjectClass\] categoryTypeOverride = 15 // TEAM\_SLOT\_POWER buildRequire = "B" buildSupport = "B" powerCost = -3

classlabel: "powerlung"  

\[GameObjectClass\] buildRequire = "N" buildSupport = "N" powerCost = -1

  
**ODF Properties:**  
* **\[PowerPlantClass\]**  
    
DoBettyPower = true  
If this is false, won't give the Betty Voice Over for "Power Lost" (EVENT\_SOUND\_12) when this object is destroyed and Power goes negative.

 PowerUpClass 

 Classlabel: "powerup"  
  
**Class Tree: Entity->GameObject->PowerUp**  
  
**Description:**  
Powerups are objects that can be picked up. They're also mobile and can be pushed by Explosion Kick or launched from an Armory.  
  
**Default ODF Properties:**  

\[GameObjectClass\] hitType = 3 // HIT\_TYPE\_VEHICLE canCollide = true boxCollide = false

  
**Recommneded AI Process:**  

aiName = "PowerUpProcess"

  
**ODF Properties:**  
* **\[PowerUpClass\]**  
    
soundPickup = ""  
Sound file played when Picked UIp. Default for is "repair.wav" for Class: ServicePowerup, and "weapon.wav" for Class: WeaponPowerup and MoneyPowerup.  
    
soundReject = ""  
Sound file played when Rejected for Pickup.  
    
Physics properties when Moving:  
alphaDamp = 2.0f; alphaTrack = 5.0f; pitchThrust = 0.5f; rollStrafe = 0.5f; omegaSpin = 2.0f; omegaTurn = 1.5f; alphaSteer = 2.0f; velocForward = 15.0f; velocReverse = 10.0f; velocStrafe = 10.0f; accelThrust = 10.0f;  
    
Physics properties when Stationary:  
StationaryAlphaDampX = 10.0f; StationaryAlphaDampY = 10.0f; StationaryAlphaDampZ = 10.0f; StationaryAlphaTrackX = 25.0f; StationaryAlphaTrackY = 20.0f; StationaryAlphaTrackZ = 25.0f; StationaryVelocDampX = 5.0f; StationaryVelocDampY = 5.0f; StationaryVelocDampZ = 5.0f;  
    
FLOAT\_HEIGHT = 1.0f  
Height above the ground.  
    
LIFT\_SPRING = 25.0f  
Lift Spring.  
    
LIFT\_DAMP = 7.0f  
Lift Dampening.  
    
SlowFall = true  
If this is false, it uses FallSpeed for vertical fall speed.  
    
FallSpeed = 10.0f  
This is a limit on how fast it can Fall from Gravity. Only used if slowFall is false. If this is <= 0 it uses Forward/Reverse velocity.  
    
ExplodeEndOfLifespan = true  
If false, won't explode when lifeSpan is over. Only applies if GameObjectClass::LifeSpan is >= 0.  
    
HitMask = 2147483647  
Bit Mask of which types of objects can accept this Powerup. If any of these bits are set to 0, an object of that type won't accept the Powerup. Valid values are:  
   * 1 : Craft  
   * 2 : Person  
   * 4 : Building  
   * 8 : PoweredBuilding  
   * 16 : Deployable  
   * 32 : Morphtank  
   * 64 : TurretCraft  
   * 128 : ServiceTruck  
   * 256 : TrackedVehicle  
   * 512 : Walker  
    
ExplodeOnBadHit = false  
If true, will Explode if an object tries to pick it up and is Rejected.  
    
DestroyOnBadHit = false  
If true, will be Destroyed (not Explode) if an object tries to pick it up and is Rejected.  
    
PowerupClassMask = 0  
Bit Mask for use in comparison with GameObjectClassPowerUpMatch and GameObjectClassPowerUpProvides for filtering which objects can pick up this object.  
    
PowerupClassMatch = 0  
Bit Mask for use in comparison with GameObjectClassPowerUpMask and GameObjectClassPowerUpProvides for filtering which objects can pick up this object.  
    
PowerupClassProvides = 0  
Bit Mask for what this object Provides for use in comparison with GameObjectClassPowerUpMask and GameObjectClassPowerUpMatch for filtering which objects can pick up this object.

 RecyclerClass 

 Classlabel: "recycler"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->Factory->Recycler**  
  
**Description:**  
Recycler is a special type of Factory that is the primary Recycle point for the Team.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 1 // TEAM\_SLOT\_RECYCLER isSingle = true buildRequire = "F" buildSupport = "B" powerCost = 0

  
**ODF Properties:**  
* **\[RecyclerClass\]**  
    
scrapHold = 10  
How much scrap this object holds on the Scrap Bar.  
    
scrapDelay = 3.0f  
Interval in seconds between generating 1 Scrap when the Scrap gauge reaches this object's bar segment.  
    
recycleX = 4.0f  
Recycle position's X position, relative to this object.  
    
recycleZ = 5.0f  
Recycle position's Z position, relative to this object.  
    
ScrapDropPoint = true  
If true, this object can be a place where Scavenger / ScavengerH with doDrop = true can dropoff Scrap.  
    
RequiresExtractor = true  
If true, requires a deployed Extractor for this object to generate Scrap. If false, will generate Scrap on it's own.  
    
RunParallel = false  
If this is true, Scrap is generated in parallel for this object, instead of in Scrap Bar sequence.

 RecyclerVehicleClass 

 Classlabel: "recyclervehicle"  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle->TrackedDeployable->DeployBuilding->RecyclerVehicle**  
  
RecyclerVehicle is a Tracked DeployBuilding that deploys into another object.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY isSingle = true canBailout = false canRescue = false buildRequire = "F" buildSupport = "B"

  
**ODF Properties:**  
* **\[RecyclerVehicleClass\]**  
    
scrapHold = 10  
How much scrap this object holds on the Scrap Bar.  
    
RequiresExtractor = true  
If true, requires a deployed Extractor for this object to generate Scrap. If false, will generate Scrap on it's own.  
    
RunParallel = false  
If this is true, Scrap is generated in parallel for this object, instead of in Scrap Bar sequence.

 RecyclerVehicleHClass 

 Classlabel: "recyclervehicleH"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Deployable->DeployBuildingH->RecyclerVehicleH**  
  
**Description:**  
RecyclerVehicle is a HoverCraft DeployBuildingH that deploys into another object.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY isSingle = true canBailout = false canRescue = false buildRequire = "F" buildSupport = "B"

  
**ODF Properties:**  
* **\[RecyclerVehicleHClass\]**  
    
scrapHold = 10  
How much scrap this object holds on the Scrap Bar.  
    
RequiresExtractor = true  
If true, requires a deployed Extractor for this object to generate Scrap. If false, will generate Scrap on it's own.  
    
RunParallel = false  
If this is true, Scrap is generated in parallel for this object, instead of in Scrap Bar sequence.

 SAVClass 

 Classlabel: "sav"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->SAV**  
  
**Description:**  
SAV Class is a HoverCraft that is also a Flier. It uses parameters from \[HoverCraftClass\] but has it's own unique physics.  
  
**Default ODF Properties:**  

\[GameObjectClass\] needPilot = false canSnipe = false

  
**Recommended AI Process:**  

aiName = "SAVFriend" aiName2 = "SAVEnemy"

  
**ODF Properties:**  
* **\[SAVClass\]**  
    
flightAltitude = 150.0f  
Altitude that it flies at when Deployed.  
    
AltitudeLookahead = 2.0f  
How far ahead in seconds it will look ahead for adjusting Altitude with Terrain.  
    
emptyAltitude = 2.0f  
Altitude it settles to when not Piloted.  
    
OverWater = true  
If this is false, it ignores Water height when calculating Altitude.  
    
soundDeploy = "trdeploy.wav"  
Sound file to play when Deploying.  
    
soundUndeploy = "trundepl.wav"  
Sound file to play when Undeploying.

 ScavengerClass 

 Classlabel: "scavenger"  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle->TrackedDeployable->Scavenger**  
  
**Description:**  
Scavenger is a special Tracked Vehicle that can Deploy into a building when it Deploys on top of a Deposit Class object. It can also pick up loose pieces of Scrap by driving over them and activating the Deploy function.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 25 // TEAM\_SLOT\_SCAVENGER

  
**Recommended AI Process:**  

aiName = "ScavProcess" aiName2 = "ScavProcess"

  
**ODF Properties:**  
* **\[ScavengerClass\]**  
    
soundPickup = "suck.wav"  
Sound file played when this object picks up a piece of Scrap.  
    
scrapHold = 20  
How much Scrap this object holds. By default this is internal hold only, and does not add to the Scrap Bar. It transfers any scrap from it's hold that will fit into the Scrap Bar immediately.  
_Note:_ If the Scrap Bar is full, it will continue to Scavenge until it's internal hold is full.  
    
deployClass = ""  
The ODF of the object this vehicle turns into when Deployed onto a Deposit Class. Must be a valid GameObject Class.  
    
enablePoolGoTo = true  
If this is false, it won't do the point-space reticle action to go to a Deposit. It is also false if the DeployClass is invalid.  
    
deployOffset = 0.0f  
How far away it moves from the Center of the pool to start Deploying when entering the SLIDE state.  
    
doDrop = false  
If false, won't instantly transfer scrap to the Scrap Hold, but instead will return to the nearest valid Drop Off point, like BZ1/98R Scavengers.  
    
DropDist = 8.0f  
If doDrop is true, this is how far it must be from the Dropoff point to transfer it's Scrap Hold to the Scrap Bar.  
    
doDropRecycler = true  
If doDrop is true, sets if this object can Dropoff scrap at a Recycler.  
    
doDropExtractor = true  
If doDrop is true, sets if this object can Dropoff scrap at an Extractor.  
    
doDropSilo = true  
If doDrop is true, sets if this object can Dropoff scrap at a Silo.  
    
CanScavenge = true  
If false, can't pick up Loose Scrap.  
    
ScrapFirst = true  
If true, will collect visible loose scrap before deploying on a pool. If false, will deploy on any nearby pools first.  
    
IsFearless = true  
If false, will flee to nearest Allied building when shot.  
    
animPickup = ""  
If specified, the animationName used when picking up a piece of Scrap.  
    
animPickupCycle = 0  
The Animation Type of the pickup animation. 0 = Loop, 1 = Two way.  
    
DeathScrapDropRatio = 0.0f  
This is the ratio of current Scrap Hold that is dropped when this object dies. Max is 5.0  
    
AddScrapHoldToTotal = false  
If this is true, it's Scrap Hold is added to the Scrap Bar and it behaves more like a mobile Extractor.  
    
RequiresExtractor = true  
If true, requires a deployed Extractor for this object to generate Scrap. If false, will generate Scrap on it's own.  
    
RunParallel = false  
If this is true, Scrap is generated in parallel for this object, instead of in Scrap Bar sequence.  
    
InitScrapDelay = 0.0f  
If AddScrapHoldToTotal is true, this is the time in seconds before it starts generating Scrap.  
    
ScrapDelay = 0.0f  
If AddScrapHoldToTotal is true, this is the time in seconds between generating 1 Scrap.  
    
ScavClassMask = 0  
Bit Mask for use against ScrapClassMatch/DepositClassMatch and ScrapClassProvides/DepositClassProvides for filtering what kinds of Scrap or Deposits this object can interact with.  
    
ScavClassMatch = 0  
Bit Mask for use against ScrapClassMask/DepositClassMask and ScrapClassProvides/DepositClassProvides for filtering what kinds of Scrap or Deposits this object can interact with.  
    
ScavClassProvides = 0  
Bit Mask this object provides against ScrapClassMask/DepositClassMask and ScrapClassMatch/DepositClassMatch for filtering what kinds of Scrap or Deposits this object can interact with.  
ChromeEffect = false  
If true, builds using Chrome method. Default is true for Race f.  
    
ChromeTexture = ""  
Environment texture applied to Chrome effect. Default is the world's environment texture.  
    
BuildSparkConfig = "sparker"  
Render name for the Build effect. Only used if ChromeEffect is false.  
    
LineStartColor = "0 127 255 255"  
Starting color for Build effect's Extrude lines.  
    
LineFinishColor = "0 0 255 0"  
Finish color for Build effect's Extrude lines.  
    
BeamColor = "0 127 255 31"  
Color for Build effect's beams that go from hp\_special on constructor object to Extrude lines)  
    
lineSolidColor = "0 63 255 127"  
LOD line Color for Build effect.  
    
SolidColorDistance = 150.0f  
LOD distance for Build effect's Extrude to switch to lineSolidColor.  
    
MaxLineDistance = 250.0f  
Max distance for Build effect's Extrude efffect.
  
* **CraftClass**  
    
ScavengerCollectPoolRange = rangeScan  
How far it can auto detect Pools.  
    
ScavengerChoosePoolRange = 300.0f  
How far it can auto choose a pool.

 ScavengerHClass 

 Classlabel: "scavengerH"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Deployable->ScavengerH**  
  
**Description:**  
Scavenger is a special Hover Vehicle that can Deploy into a building when it Deploys on top of a Deposit Class object. It can also pick up loose pieces of Scrap by driving over them and activating the Deploy function.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 25 // TEAM\_SLOT\_SCAVENGER

  
**Recommended AI Process:**  

aiName = "ScavHProcess" aiName2 = "ScavHProcess"

  
**ODF Properties:**  
* **\[ScavengerHClass\]**  
    
soundPickup = "suck.wav"  
Sound file played when this object picks up a piece of Scrap.  
    
scrapHold = 20  
How much Scrap this object holds. By default this is internal hold only, and does not add to the Scrap Bar. It transfers any scrap from it's hold that will fit into the Scrap Bar immediately.  
_Note:_ If the Scrap Bar is full, it will continue to Scavenge until it's internal hold is full.  
    
deployClass = ""  
The ODF of the object this vehicle turns into when Deployed onto a Deposit Class. Must be a valid GameObject Class.  
    
enablePoolGoTo = true  
If this is false, it won't do the point-space reticle action to go to a Deposit. It is also false if the DeployClass is invalid.  
    
deployOffset = 0.0f  
How far away it moves from the Center of the pool to start Deploying when entering the SLIDE state.  
    
doDrop = false  
If false, won't instantly transfer scrap to the Scrap Hold, but instead will return to the nearest valid Drop Off point, like BZ1/98R Scavengers.  
    
DropDist = 8.0f  
If doDrop is true, this is how far it must be from the Dropoff point to transfer it's Scrap Hold to the Scrap Bar.  
    
doDropRecycler = true  
If doDrop is true, sets if this object can Dropoff scrap at a Recycler.  
    
doDropExtractor = true  
If doDrop is true, sets if this object can Dropoff scrap at an Extractor.  
    
doDropSilo = true  
If doDrop is true, sets if this object can Dropoff scrap at a Silo.  
    
CanScavenge = true  
If false, can't pick up Loose Scrap.  
    
ScrapFirst = true  
If true, will collect visible loose scrap before deploying on a pool. If false, will deploy on any nearby pools first.  
    
IsFearless = true  
If false, will flee to nearest Allied building when shot.  
    
animPickup = ""  
If specified, the animationName used when picking up a piece of Scrap.  
    
animPickupCycle = 0  
The Animation Type of the pickup animation. 0 = Loop, 1 = Two way.  
    
DeathScrapDropRatio = 0.0f  
This is the ratio of current Scrap Hold that is dropped when this object dies. Max is 5.0  
    
AddScrapHoldToTotal = false  
If this is true, it's Scrap Hold is added to the Scrap Bar and it behaves more like a mobile Extractor.  
    
RequiresExtractor = true  
If true, requires a deployed Extractor for this object to generate Scrap. If false, will generate Scrap on it's own.  
    
RunParallel = false  
If this is true, Scrap is generated in parallel for this object, instead of in Scrap Bar sequence.  
    
InitScrapDelay = 0.0f  
If AddScrapHoldToTotal is true, this is the time in seconds before it starts generating Scrap.  
    
ScrapDelay = 0.0f  
If AddScrapHoldToTotal is true, this is the time in seconds between generating 1 Scrap.  
    
ScavClassMask = 0  
Bit Mask for use against ScrapClassMatch/DepositClassMatch and ScrapClassProvides/DepositClassProvides for filtering what kinds of Scrap or Deposits this object can interact with.  
    
ScavClassMatch = 0  
Bit Mask for use against ScrapClassMask/DepositClassMask and ScrapClassProvides/DepositClassProvides for filtering what kinds of Scrap or Deposits this object can interact with.  
    
ScavClassProvides = 0  
Bit Mask this object provides against ScrapClassMask/DepositClassMask and ScrapClassMatch/DepositClassMatch for filtering what kinds of Scrap or Deposits this object can interact with.  
ChromeEffect = false  
If true, builds using Chrome method. Default is true for Race f.  
    
ChromeTexture = ""  
Environment texture applied to Chrome effect. Default is the world's environment texture.  
    
BuildSparkConfig = "sparker"  
Render name for the Build effect. Only used if ChromeEffect is false.  
    
LineStartColor = "0 127 255 255"  
Starting color for Build effect's Extrude lines.  
    
LineFinishColor = "0 0 255 0"  
Finish color for Build effect's Extrude lines.  
    
BeamColor = "0 127 255 31"  
Color for Build effect's beams that go from hp\_special on constructor object to Extrude lines)  
    
lineSolidColor = "0 63 255 127"  
LOD line Color for Build effect.  
    
SolidColorDistance = 150.0f  
LOD distance for Build effect's Extrude to switch to lineSolidColor.  
    
MaxLineDistance = 250.0f  
Max distance for Build effect's Extrude efffect.
  
* **CraftClass**  
    
ScavengerCollectPoolRange = rangeScan  
How far it can auto detect Pools.  
    
ScavengerChoosePoolRange = 300.0f  
How far it can auto choose a pool.

 ScrapClass 

 Classlabel: "scrap"  
  
**Class Tree: Entity->GameObject->Scrap**  
  
**Description:**  
Scrap is a resource that can be picked up by Scavenger/ScavengerH and can be dropped upon death by most objects.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canCollide = false canInteract = false

  
**ODF Properties:**  
* **\[ScrapClass\]**  
    
lifeTime = 60.0f  
Time in seconds before this object disappears.  
    
lifeVariance = 10.0f  
Variance applied to lifeTime.  
    
ScrapClassMask = 0  
Bit Mask used to against ScavClassMatch/ScavClassProvides to filter what kinds of Scavenger/ScavengerH can pick up this piece of Scrap.  
    
ScrapClassMatch = 0  
Bit Mask used to against ScavClassMask/ScavClassProvides to filter what kinds of Scavenger/ScavengerH can pick up this piece of Scrap.  
    
ScrapClassProvides = 0  
Bit Mask this object provides against ScavClassMask/ScavClassMatch to filter what kinds of Scavenger/ScavengerH can pick up this piece of Scrap.

 ServicePowerup 

 Classlabel: "servicepod" or "repairkit" or "ammopack"  
  
**Class Tree: Entity->GameObject->PowerUp->ServicePowerup**  
  
**Description:**  
This is a powerup that can resupply health or ammo. Default soundPickup is "repair.wav"  
  
**Default ODF Properties:**  

\[PowerUpClass\] soundPickup = "repair.wav"

  
**ODF Properties:**  
Depending on the Classlabel, one of these is used:  
* **\[ServicePowerupClass\]** or **\[HealthPowerupClass\]** or **\[AmmoPowerupClass\]**  
    
healthUp = 0  
How much Health it supplies. Default is 1000 for repairkit and servicepod.  
    
ammoUp = 0  
How much Ammo it supplies. Default is 1000 for ammopack and servicepod.  
    
serviceUp = 0  
This sets both healthUp and ammoUp, and overrides those if used. Default is 1000 for both for servicepod.  
    
localAmmoUp = 0  
How much Local Ammo this powerup can replenish. Resupplies all Local Ammo Weapons on the vehicle that picks it up.

 ServiceTruckClass 

 Classlabel: "service"  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle->ServiceTruck**  
  
**Supported Animations:**  
* Deploy
  
**Description:**  
Service Trucks are Tracked vehicles that can repair a single object nearby.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY needPilot = false \[CraftClass\] canRescue = false

  
**Recommended AI Process:**  

aiName = "ServiceProcess" aiName2 = "ServiceProcess"

  
**ODF Properties:**  
* **\[ServiceTruck\]**  
    
supplyRange = 20.0f  
How close it has to be to start Servicing.  
    
supplyRadius = 5.0f  
The radius of the healing sphere.  
    
healthRate = 0.0f  
Amount of Health supplied per second.  
    
ammoRate = 0.0f  
Amount of Ammo supplied per second.  
    
supplyRate = 0.0f  
This is the amount of Health and Ammo supplied per second. This overrides HealthRate/AmmoRate if specified.  
    
localAmmoRate = 0.0f  
How much Local Ammo is supplied per second. This applies to all Local Ammo Weapons on the craft.  
    
ServiceAllies = false  
If this is true, it will automatically Service Allied things.  
    
AllyRangeScan = supplyRange  
If ServiceAllies is true, this is the range which it uses to select Allied targets to heal. Default is EngageRange if not specified.  
    
supplySound = ""  
The sound file used when this object is Servicing.  
    
supplyHard = ""  
Model piece name that the Service Beam is emitted from.  
    
supplyEffect = ""  
Render name for the Service Beam.  
    
objPush = -0.5f  
Factor of Push applied to the Service Target.  
    
objDrag = -0.1f  
Factor of Drag applied to the Service Target.  
    
ServiceTruckClassServiceMask = 0  
Bit Mask used against GameObjectClassServiceMatch/GameObjectClassServiceProvides for filtering what kind of objects this ServiceTruck can service.  
    
ServiceTruckClassServiceMatch = 0  
Bit Mask used against GameObjectClassServiceMask/GameObjectClassServiceProvides for filtering what kind of objects this ServiceTruck can service.  
    
ServiceTruckClassServiceProvides = 0  
Bit Mask this object provides against GameObjectClassServiceMask/GameObjectClassServiceMatch for filtering what kind of objects this ServiceTruck can service.  
    
**Auto Service Selection**  
    
ServiceSTs = false  
If true, will automatically service other Service Trucks.  
    
ServiceCraft = true  
If true, will automatically service Craft.  
    
ServiceBuildings = true  
if true, will automatically service Buildings.  
    
ServicePilots = false  
If true, will automatically service Persons.  
    
ServiceOther = false  
If true, will automatically service Other.

 ServiceTruckHClass 

 Classlabel: "serviceH"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->ServiceTruckH**  
  
**Supported Animations:**  
* Deploy
  
**Description:**  
Service Trucks are Tracked vehicles that can repair a single object nearby.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY needPilot = false \[CraftClass\] canRescue = false

  
**Recommended AI Process:**  

aiName = "ServiceHProcess" aiName2 = "ServiceHProcess"

  
**ODF Properties:**  
* **\[ServiceTruckH\]**  
    
supplyRange = 20.0f  
How close it has to be to start Servicing.  
    
supplyRadius = 5.0f  
The radius of the healing sphere.  
    
healthRate = 0.0f  
Amount of Health supplied per second.  
    
ammoRate = 0.0f  
Amount of Ammo supplied per second.  
    
supplyRate = 0.0f  
This is the amount of Health and Ammo supplied per second. This overrides HealthRate/AmmoRate if specified.  
    
localAmmoRate = 0.0f  
How much Local Ammo is supplied per second. This applies to all Local Ammo Weapons on the craft.  
    
ServiceAllies = false  
If this is true, it will automatically Service Allied things.  
    
AllyRangeScan = supplyRange  
If ServiceAllies is true, this is the range which it uses to select Allied targets to heal. Default is EngageRange if not specified.  
    
supplySound = ""  
The sound file used when this object is Servicing.  
    
supplyHard = ""  
Model piece name that the Service Beam is emitted from.  
    
supplyEffect = ""  
Render name for the Service Beam.  
    
objPush = -0.5f  
Factor of Push applied to the Service Target.  
    
objDrag = -0.1f  
Factor of Drag applied to the Service Target.  
    
ServiceTruckClassServiceMask = 0  
Bit Mask used against GameObjectClassServiceMatch/GameObjectClassServiceProvides for filtering what kind of objects this ServiceTruck can service.  
    
ServiceTruckClassServiceMatch = 0  
Bit Mask used against GameObjectClassServiceMask/GameObjectClassServiceProvides for filtering what kind of objects this ServiceTruck can service.  
    
ServiceTruckClassServiceProvides = 0  
Bit Mask this object provides against GameObjectClassServiceMask/GameObjectClassServiceMatch for filtering what kind of objects this ServiceTruck can service.  
    
**Auto Service Selection**  
    
ServiceSTs = false  
If true, will automatically service other Service Trucks.  
    
ServiceCraft = true  
If true, will automatically service Craft.  
    
ServiceBuildings = true  
if true, will automatically service Buildings.  
    
ServicePilots = false  
If true, will automatically service Persons.  
    
ServiceOther = false  
If true, will automatically service Other.

 ShieldTowerClass 

 Classlabel: "shieldtower"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->ShieldTower**  
  
**Description:**  
ShieldTower is a building that creates a rectangular, uni-directional Manget field.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 21 // TEAM\_SLOT\_SHIELDTOWER

  
**ODF Properties:**  
* **\[ShieldTowerClass\]**  
    
X Axis: Left / Right.  
shieldMinX = -50.0f  
Minimum Shield boundary on the X axis.  
    
shieldMaxX = 50.0f  
Maximum Shield boundary on the X axis.  
    
Y Axis: Up / Down  
shieldMinY = 0.0f  
Minimum Shield boundary on the Y axis.  
    
shieldMaxY = 10.0f  
Maximum Shield boundary on the Y axis.  
    
Z Axis: Forward / Backward  
shieldMinZ = -5.0f  
Minimum Shield boundary on the Z axis.  
    
shieldMaxZ = 5.0f  
Maximum Shield boundary on the Z axis.  
    
objPush = 100.0f  
Object Push force.  
    
objDrag = 1.0f  
Object Drag force.  
    
ordPush = 200.0f  
Ordnance Push force.  
    
ordDrag = 3.0f  
Ordnance Drag force.  
    
ForceMass = -1  
If this is < 0, default behavior is applied. If this is > 0, then the Force applied to the object is multiplied by (ForceMass / Target's Mass).  
    
MinForceMassScale = 0.0001  
If ForceMass is > 0, this is the minimum mass it clamps to.  
    
MaxForceMassScale = 1.0  
If ForceMass is > 0, this is the maximum mass it clamps to.  
    
TeamFilter = 0  
Team Filter applied to both Objects and Ordnance. Valid values:  
Team  
Craft  
Ordnance  
All Teams  
0  
0  
Same Team Only  
1  
16  
Allies  
2  
32  
Enemies  
3  
48  
Not Same Team  
4  
64

 SiloClass 

 Classlabel: "silo"  
  
**Class Tree: Entity->GameObject->Building->Silo**  
  
**Description:**  
Silo is a type of Building that is capable of generating Scrap.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canDetect = true canInteract = true buildRequire = "B" buildSupport = "B"

  
**ODF Properties:**  
* **\[SiloClass\]**  
    
initDelay = 10.0f  
Time, in seconds, before this object starts to generate Scrap.  
_Note:_ If the Scrap Bar reaches this Extractor's Scrap Segment before this timer is up, it will wait unil this timer expires before generating more Scrap.  
    
scrapDelay = = 10.0f  
The interval, in seconds, between producing 1 Scrap.  
    
scrapHold = 10  
Amount of Scrap storage this object adds to the Scrap Bar.  
    
ScrapDropPoint = true  
If this is true, Scavenger and ScavengerH with doDrop set to true can Dropoff scrap here.  
    
RunParallel = false  
If this is true, Scrap is generated in parallel for this object, instead of in Scrap Bar sequence.  
    
RequiresExtractor = true  
If true, requires a deployed Extractor for this object to generate Scrap. If false, will generate Scrap on it's own.

 SpawnBuoyClass 

 Classlabel: "spawnpnt"  
  
**Class Tree: Entity->GameObject->Dummy->SpawnBuoy**  
  
**Description:**  
Spawn Buoy is used as a Spawn point for Players in MP games / Mission Scripts.  
  
**Default ODF Properties:**  

\[GameObjectClass\] isTerrain = false scanTeamLimit = 3

 SprayBuildingClass 

 Classlabel: "spraymine"  
  
**Class Tree: Entity->GameObject->Building->SprayBuilding**  
  
**Description:**  
Spray Building is more like a Mine that sprays an Ordnance Class around in a circle.  
  
**ODF Properties:**  
* **\[SprayBuildingClass\]**  
    
payloadName = ""  
ODF name of the Ordnance Class to fire.  
    
fireSound = ""  
Sound file played when firing.  
    
triggerDelay = 1.0f  
Time in seconds before it starts shooting.  
    
setAltitude = 2.0f  
Altitude it raises up to.  
    
omegaSpin = 0.0f  
Turn rate.  
    
shotDelay =  
Time in seconds between firing it's payloadName.  
    
anglePitch = 0.25f  
Randomized pitch angle for it's Ordnance trajectory.  
    
LiftSpring = 3.0f  
It's Lift Spring.  
    
MaxYSpeed = 1e6  
Maximum speed it raises up to SetAltitude.

 SupplyDepotClass 

 Classlabel: "supplydepot"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->SupplyDepot**  
  
**Description:**  
SupplyDepots are Buildings that can repair objects nearby.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 12 // TEAM\_SLOT\_SERVICE isSingle = true

  
**ODF Properties:**  
* **\[SupplyDepotClass\]**  
    
supplyRange = 20.0f  
How close an object has to be to start recieving Servicing.  
    
healthRate = 0.0f  
Amount of Health supplied per second.  
    
ammoRate = 0.0f  
Amount of Ammo supplied per second.  
    
supplyRate = 0.0f  
This is the amount of Health and Ammo supplied per second. This overrides HealthRate/AmmoRate if specified.  
    
localAmmoRate = 0.0f  
How much Local Ammo is supplied per second. This applies to all Local Ammo Weapons on the craft.  
    
ServiceAllies = true  
If this is true, it will automatically Service Allied things. if false, will only Service same Team.  
    
ServiceParallel = false  
If this is true, it services all nearby valid Targets simultaneously instead of the lowest health/ammo one first.  
    
supplySound = ""  
The sound file used when this object is Servicing.  
    
SupplyDepotClassServiceMask = 0  
Bit Mask used against GameObjectClassServiceMatch/GameObjectClassServiceProvides for filtering what kind of objects this SupplyDepot can service.  
    
SupplyDepotClassServiceMatch = 0  
Bit Mask used against GameObjectClassServiceMask/GameObjectClassServiceProvides for filtering what kind of objects this SupplyDepot can service.  
    
SupplyDepotClassServiceProvides = 0  
Bit Mask this object provides against GameObjectClassServiceMask/GameObjectClassServiceMatch for filtering what kind of objects this SupplyDepot can service.  
    
**Auto Service Selection**  
    
ServiceSTs = true  
If true, will automatically service other Service Trucks.  
    
ServiceCraft = true  
If true, will automatically service Craft.  
    
ServiceBuildings = false  
if true, will automatically service Buildings.  
    
ServicePilots = false  
If true, will automatically service Persons.  
    
ServiceOther = false  
If true, will automatically service Other.

 TechCenterClass 

 Classlabel: "techcenter"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->TechCenter**  
  
**Description:**  
TechCenter is a Powered Building that defaults to CategoryType 13, which is limited to isSingle = true by default.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 13 // TEAM\_SLOT\_TECHCENTER

 TelePortalClass 

 Classlabel: "teleportal"  
  
**Class Tree: Entity->GameObject->Building->PoweredBuilding->TelePortal**  
  
**Description:**  
TelePortal is a PoweredBuilding that once had code to render a Portal Effect of some kind. Currently it does nothing special.  
  
**Default ODF Properties:**  

\[GameObjectClass\] buildRequire = "A" buildSupport = "A"

 TrackedDeployableClass 

 Classlabel: "trackdeploy"  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle->TrackedDeployable**  
  
**Description:**  
A Tracked Vehicle that can Deploy.  
  
**ODF Properties:**  
* **\[TrackedDeployableClass\]**  
    
timeDeploy = 5.0f  
Time in seconds it takes to Deploy.  
    
timeUndeploy = 5.0f  
Time in seconds it takes to Undeploy.  
    
soundDeploy = "trdeploy.wav"  
Sound file played when this object Deploys.  
    
soundUndeploy = "trundepl.wav"  
Sound file played when this object Undeploys.  
    
isStealthDeployed = false  
If true, this object is hidden from Radar / Target if line of sight is blocked.

 TrackedVehicleClass 

 Classlabel: "tracked"  
  
**Class Tree: Entity->GameObject->Craft->TrackedVehicle**  
  
Tracked Vehicles are Craft that require model pieces named Tractor\_l / Tractor\_r and attached Tread\_l / Tread\_r respectively.   
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY canSnipe = false isAssault = true

  
**ODF Properties:**  
* **\[TrackedVehicleClass\]**  
    
omegaSpin = 5.0f  
Turn rate while stationary.  
    
omegaTurn = 2.0f  
Turn rate while moving.  
    
alphaSteer = 5.0f  
Steering Acceleration.  
    
velocForward = 10.0f  
Maximum forward velocity from Thrusting.  
    
velocReverse = 5.0f  
Maximum reverse velocity from Thrusting.  
    
accelThrust = 5.0f  
Acceleration rate when Thrusting.  
    
treadSound = "engthrst.wav"  
Sound file played when the Thrusting. Ramps up with Throttle.  
    
engineSound = "engthrst.wav"  
Sound file played when not Thrusting.  
    
pitchThrust = 0.0f  
Pitch from Thrusting.  
    
rollSteer = 0.0f  
Roll from Steering.  
    
alphaTrack = 0.0f  
Terrain tracking acceleration.  
    
NormalTrackFactor = 0.0f  
Terrain Normal Traction modifier for alphaTrack.  
    
alphaDampX = 0.0f  
Acceleration Damping on the X Axis.  
    
alphaDampZ = 0.0f  
Acceleration Damping on the Z Axis.  
    
LiftSpring = 5.0f  
Lift Spring while Airborne.  
    
TreadForceFeedback = 1.0f  
Multiplier on how much of the Acceleration effects the rotation of the Body.  
    
LevelForce = 10.0f  
Leveling force applied to Acceleration.  
    
ThrustTrack = 0.0f  
Modifier for how much Thrusting affects PitchThrust/RollSteer.  
    
CENTER\_SHIFT = -0.4f  
Vertical position Modifier for Center of Gravity of the craft. Valid values: -1.0 for bottom, 0.0 for center, +1.0 for top  
    
SUSPENSION\_MIN = -0.2f  
Minimum Suspension Spring.  
    
SUSPENSION\_MAX = 0.3f  
Maximum Suspension Spring.  
    
SPRING\_FACTOR = 2.0f  
Suspension Spring stiffness factor.  
    
DAMPING\_FACTOR = 2.0f  
Suspension Dampening stiffness factor.  
    
TREAD\_STATIC\_FRICTION = 1.0f  
Track Friction multiplier on Spring force.  
    
UseGlobalFriction = false  
If this is true, it uses an alternate friction code path, and the following parameters are used.  
    
GlobalFrictionMaxThrottle = 0.04f  
Maximum Throttle for the code to take effect.  
    
GlobalFrictionMaxHeight = 2.0f  
Maximum height for the code to take effect.  
    
GlobalFrictionStaticCoeff = 0.4f  
Static Friction Coefficient.  
    
GlobalFrictionDynamicCoeff = 0.24f  
Dynamic Friction Coefficient.  
    
CanWaterDamage = true  
If false, won't take Damage from being submerged in Water.  
    
WaterDamageMinDepth = 1.0f  
If CanWaterDamage is true, the minimum Depth below Water this object must be to take Damage.  
    
WaterDamageMultiplier = 100.0f  
If CanWaterDamage is true, and this is the Damage multiplier by current Depth to apply Damage per second.  
    
LimitVelocity = -1  
If this is > 0.0001, then horizontal velocity is clamped to this.  
    
LimitVelocityDamage = 0  
If limitVelocity is > 0, this is the damage done to the unit per second when it's Velocity exceeds the value of limitVelocity.  
    
Use13Treads = true  
If false, uses the old 1.2 Tread code path, which only uses omegaSpin, not both omegaSpin+omegaTurn. Also the model piece for the Treads needs \_\_h appended to it in the non 13 code path.  
    
**AI Only Physics Parameters:**  
AIomegaSpin = omegaSpin AIomegaTurn = omegaTurn AIalphaSteer = alphaSteer AIvelocForward = velocForward AIvelocReverse = velocReverse AIaccelThrust = accelThrust  
_Note:_ These parameters default to the normal versions, and do **NOT** support ODF Inheritance.

 TorpedoClass 

 Classlabel: "torpedo"  
  
**Class Tree: Entity->GameObject->Torpedo**  
  
**Description:**  
Torpedo Class is a GameObject that moves towards a Target, and explodes upon Collision.  
  
**Default ODF Properties:**  

\[GameObjectClass\] canCollide = true boxCollide = false useVehicleCrashOnDeath = false numChunks = 0

  
**Recommended AI Process:**  

aiName = "TorpedoProcess" aiName2 = "TorpedoProcess"

  
**ODF Properties:**  
* **\[TorpedoClass\]**  
    
setAltitude = 1.0f  
Altitude that this object flies at.  
    
alphaTrack = 20.0f  
Terrain Tracking acceleration.  
    
alphaDamp = 5.0f  
Dampening acceleration.  
    
velocForward = 25.0f  
Forward velocity from Thrust.  
    
accelThrust = 10.0f  
Thrusting acceleration.  
    
omegaTurn = 1.0f  
Turn speed.  
    
alphaSteer = 5.0f  
Steering Acceleration.  
    
lifeSpan = 60.0f  
Time in seconds until it expires.  
    
xplBlast = ""  
ODF name for the Explosion Class triggered when this object Detonates.  
    
soundThrust = ""  
Sound file for this object's Engine thrust.  
    
LIFT\_SPRING = 40.0f  
Lift Spring.  
    
LIFT\_DAMP = 15.0f  
Life Dampening.  
    
SlowFall = true  
If this is False, the torpedo is effected by Gravity similar to hovercraft.

 TugClass 

 Classlabel: "tug"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Tug**  
  
**Supported Animations:**  
* Deploy
  
**Description:**  
Tug is a class that can Deploy to pick up other objects. Unlike BZ1/98R Tugs, the Tugs in BZ2 use a strong Magnetic Field to hold the objects. This means they can wiggle and sway when being held, and technically can be knocked loose with enough force.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 24 // TEAM\_SLOT\_UTILITY needPilot = false \[CraftClass\] canRescue = false

  
**Recommended AI Process:**  

aiName = "TugFriend" aiName2 = "TugEnemy"

  
**ODF Properties:**  
* **\[TugClass\]**  
    
dockSpeed 4.0f  
Time in seconds it takes to pick up an object.  
    
fieldRadius = 20.0f  
How big the Magnet field is.  
    
fieldOffset = 4.0f  
Position offset of the field, along the Z axis.  
_Note:_ Inverse of Forward which means positive values are Backwards, and negative values are Forwards.  
    
accelCenter = 0.0f  
How much acceleration is applied in the Cargo object near the Center of the Magnet Field.  
    
accelEdge = -50.0f  
How much acceleration is applied to the Cargo object near the Edge of the Magnet Field.  
    
accelDrag = 10.0f  
Acceleration Drag applied to the Cargo object.  
    
alphaDamp = 10.0f  
Acceleration Dampening applied to the Cargo object.  
    
alphaTrack = 20.0f  
Turn Acceleration traction applied to the Cargo object.  
    
UseLiftSpring = true  
If this is true, it uses the CargoLiftSpring to help keep the Cargo object at a raised altitude.  
    
CargoLiftSpring = 10.0f  
Only used if UseLiftSpring is true. Life Spring applied to the Cargo object.  
    
RotateWithTug = false  
If this is true, the Cargo object's rotation is kept relative to the Tug's rotation. If false, Cargo's rotation is independent of Tug's rotation.

 TurretCraftClass 

 Classlabel: "turret"  
  
**Class Tree: Entity->GameObject->Craft->TurretCraft**  
  
**Description:**  
TurretCraft is a strange combination of a Craft that behaves like a Building. This is why Gun Towers count as Craft instead of Buildings.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 20 // TEAM\_SLOT\_GUNTOWER powerCost = 1 buildRequire = "A" buildSupport = "A" needPilot = false canSnipe = false isAssault = true isGrouped = false needGroup = false terrainBlendRadius = 3

  
**Recommended AI Process:**  

aiName = "GunTowerFriend" aiName2 = "GunTowerEnemy"

  
**ODF Properties:**  
* **\[BuildingClass\]**  
    
soundAmbient = ""  
This object's Ambient Sound.  
    
AmbeintSoundWhenUnpowered = false  
If this is true, AmbientSound continues to play while this object is unpowered.  
    
bldEdge = ""  
If specified, this is the Building's Tunnel Edge. This consists of 4 letters that represent each side's connection. Connections are in clock-wise order N, E, S, W. Valid values are:  
   * W = Wall  
   * T = Terrain  
   * F = Tunnel  
    
tunnelCount = 0  
How many Tunnel segments are on this object.  
    
Tunnel Info is labeled "tunnel\_\_...", where \_\_ is the count. Starting at 00, and increment to 99\. For each Tunnel Count:  
tunnel00X0 = 0.0  
Starting position on X Axis.  
    
tunnel00Z0 = 0.0  
Starting position on Z Axis.  
    
tunnel00Dx = 0.0  
Size on the X Axis.  
    
tunnel00Dz = 0.0  
Size on the Z Axis.  
    
tunnel00Edge  
This Tunnel Segment's Edge. This consists of 4 letters that represent each side's connection. Connections are in clock-wise order N, E, S, W. Valid values are:  
   * W = Wall  
   * T = Terrain  
   * F = Tunnel  
    
tunnelClusterSize = 4.0f  
Tunnel cluster size.  
    
justTerrain = false  
If true, Pathing includes just the Terrain under this object.  
    
justFlat = false  
If true, Pathing is made completely flat under this object.  
    
easyTunnels = false  
If this is true, it assumes anything can fit through the tunnel regardless of size.  
    
ReplacesObject = false  
If this is true, then it acts like an Extractor and replaces the object that was under it. Default is true for Class: Extractor.  
    
AlignsToObject = false  
If this is true, it aligns to face the same direction as the object it's replacing. Default is true for Class: Extractor.
  
  
* **\[TurretCraftClass\]**  
    
omegaTurret = 2.0f  
Turret turn speed.  
    
alphaTurret = 5.0f  
Turret turn acceleration.  
    
yawMin = -1e30  
Min Turret turn angle.  
    
yawMax = 1e30  
Max Turret turn angle.  
    
pitchFilter = 5.0f  
Pitch acceleration.  
    
powerName = ""  
If specified, this is used as the powerName for all Taps not otherwise specified.  
    
powerTap1 ... powerTap8 = ""  
Model piece name for this Tap object.  
    
powerName1 ... powerName8 = powerName  
The ODF name for each Tap object. Must be a GameObject Class. Default is powerName if not specified.  
    
AutoBuildTap1 ... AutoBuildTap8 = true  
If this is false, it won't automatically spawn the Tap when this object is created.  
    
PoweredByTaps = true  
If this is false, Taps don't count towards this Object's Power Cost.  
    
DestroyTapsWithParent = true  
If this is false, Taps aren't destroyed when this object dies.  
    
detectRange = 200.0f  
Range at which it shows Enemies on Radar.  
    
CanDemolish = true  
If this is false, does not appear in Constructor's Demolish menu.  
    
CanAlliedCommanderDemolish = true  
In an MP Team Play game, sets if the Commander can Demolish this object.  
    
CanAlliedThugDemolish = false  
In an MP Team Play game, sets if a Thug can Demolish this object.  
    
CanAlliedThugUseTerminal = true  
If this is false, Allied players in Multiplayer can't use this object's Terminal.

 TurretTankClass 

 Classlabel: "turrettank"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Deployable->TurretTank**  
  
**Description:**  
Turret Tank is a Deployable Hovercraft that supports a Turret.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 23 // TEAM\_SLOT\_DEFENSE

  
**Recommended AI Process:**  

aiName = "TurretTankFriend" aiName2 = "TurretTankEnemy"

  
**ODF Properties:**  
* **\[TurretTankClass\]**  
    
omegaTurret = 2.0f  
Turret turn speed.  
    
alphaTurret = 5.0f  
Turret turn acceleration.  
    
yawMin = -1e30  
Min Turret turn angle.  
    
yawMax = 1e30  
Max Turret turn angle.  
    
pitchFilter = 10.0f  
Pitch acceleration.

 WalkerClass 

 Classlabel: "iv\_walker" or "fv\_walker"  
  
**Class Tree: Entity->GameObject->Craft->Walker**  
  
**Description:**  
Walker is a Craft that requires feet pieces and has special Walking animations. It also has a Head piece that can swivel.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 22 // TEAM\_SLOT\_OFFENSE canSnipe = false boxCollide = true isAssault = true

  
**Recommended AI Process:**  

aiName = "GechProcess" aiName2 = "GechProcess"

  
**ODF Properties:**  
* **\[WalkerClass\]**  
    
is13Walker = true  
If this is false, uses old Model hierarchy code.  
    
Walker12Type = -1  
If Is13Walker is false, this setting is used. Valid values: -1 = Default, use Race letter to determine higherarchy. i = ISDF, everything else = Scion. 0 = ISDF style, 1 = Scion style.  
    
GroundInteractHeight = 0.2f  
Height tolerance from Ground to be considered not Airborne.  
    
velocWalkFactor = 0.5f  
Percent of velocForward that it switches from Walk to Run animations. Min is 0.3, Max is 0.8.  
    
alphaDamp = 3.0f  
Dampening acceleration.  
    
alphaTrack = 15.0f  
Terrain Tracking acceleration.  
    
pitchPitch = 0.25f  
Pitch from Pitching.  
    
pitchThrust = 0.1f  
Pitch from Thrusting.  
    
velocForward = 4.0f  
Maximum forward speed from Thrusting.  
    
velocReverse = 3.0f  
Maximum reverse speed from Thrusting.  
    
accelThrust = 6.0f  
Acceleration from Thrusting.  
    
omegaTurn = 20.0f  
Turn speed.  
    
velocJump = 10.0f  
Velocity from Jumping.  
    
omegaTurnAttenuation = 0.2f  
    
AI Only versions of physics settings. These default to their non-AI values:  
AIalphaDamp = alphaDamp AIalphaTrack = alphaTrack AIpitchPitch = pitchPitch AIpitchThrust = pitchThrust AIvelocForward = velocForward AIvelocReverse = velocReverse AIaccelThrust = accelThrust AIomegaTurn = omegaTurn AIvelocJump = velocJump AIomegaTurnAttenuation = omegaTurnAttenuation  
_Note:_ These do not support ODF Inheritance.  
    
jumpSound = "jump.wav"  
Sound file played when this unit Jumps.  
    
landSound = "land.wav"  
Sound file played when this units Lands.  
    
stepSound = "step.wav"  
Sound file played when one of the foot pieces makes contact with the Ground on Terrain.  
    
splashSound = "splash.wav"  
Sound file played when one of the foot pieces makes contact with the Ground under Water.  
    
engineSound = "engthrst.wav"  
Sound file played for this unit's Engine.  
    
headpiece = "head"  
Model piece name for this unit's Head Turret.  
    
leftfootpiece = "lfoot"  
Model piece name for the Left Foot piece.  
    
rightfootpiece = "rfoot"  
Model piece name for the Right Foot piece.  
    
headYawRate = 200.0f  
Head turn rate in Degrees per second.  
_Note:_ This differs from all other Yaw/Pitch rate inptus which are Radians per second.  
    
minHeadYaw = -80.0f  
Minimum Head Yaw in Degrees.  
_Note:_ This differs from all other Yaw/Pitch rate inptus which are Radians per second.  
    
maxHeadYaw = 80.0f  
Maximum Head Yaw in Degrees.  
_Note:_ This differs from all other Yaw/Pitch rate inptus which are Radians per second.  
    
headYawFilter = 10.0f  
How fast Head Yaw can change.  
    
minHeadPitch = -30.0f  
Minimum Head Pitch in Degrees.  
_Note:_ This differs from all other Yaw/Pitch rate inptus which are Radians per second.  
    
maxHeadPitch = 30.0f  
Maximum Head Pitch in Degrees.  
_Note:_ This differs from all other Yaw/Pitch rate inptus which are Radians per second.  
    
headPitchFilter = 10.0f  
How fast Head Pitch can change.  
    
CanWaterDamage = false  
If true, takes Damage from being under Water, similar to TrackedVehicle.  
    
attackSpeed = topSpeed.  
Speed which it moves at when Attacking. Default is CraftClass topSpeed.  
    
FRICTION\_COEF = 0.35f  
Friction Coefficient with the Ground.  
    
DeathTimer = 3.0f  
How long it waits to play animations when this object disappears.  
    
ExplodeTimer = 0.4f  
Time left in DeathTimer at which the Explosion will occur.

 WeaponPowerupClass 

 Classlabel: "wpnpower"  
  
**Class Tree: Entity->GameObject->PowerUp->WeaponPowerup**  
  
**Description:**  
Weapon Powerups can be used to allow an object to equip a Weapon.   
  
**Default ODF Properties:**  

\[PowerUpClass\] soundPickup = "weapon.wav"

  
**ODF Properties:**  
* **\[WeaponPowerupClass\]**  
    
weaponName = ""  
The ODF name of the Weapon. Must be a valid Weapon Class.  
    
RefreshWeaponOnly = false  
If true, will only give the weapon to units that already have that weapon. Useful for refilling Local Ammo on a specific weapon.

 WingmanClass 

 Classlabel: "wingman"  
  
**Class Tree: Entity->GameObject->Craft->HoverCraft->Wingman**  
  
**Description:**  
Wingman class is a HoverCraft that counts as an Offensive unit.  
  
**Default ODF Properties:**  

\[GameObjectClass\] categoryTypeOverride = 22 // TEAM\_SLOT\_OFFENSIVE

 WeaponClass 

 Classlabel: "weapon"  
  
**Class Tree: Entity->Weapon**  
  
**Description:**  
Weapon Class is the root class for all Weapons. The ODF files for WeaponClass ODFs traditionally start with "g" for Gun.  
  
**ODF Properties:**  
* **\[WeaponClass\]**  
    
altName = ""  
If this is specified, it is an Alternate WeaponClass, that is switched to when an object carrying this Weapon Deploys and triggers the switch with a switchMask. MorphTanks are the most common example of this.  
    
ordName = ""  
The ODF name for the OrdnanceClass that this weapon fires.  
    
fireSound = ""  
Sound file played when this weapon is fired.  
    
flashName = ""  
Render name for the Flash effect.  
    
flashTime = 0.0f  
Time for the flash effect to play on MP remote players, + 0.1 seconds.  
    
wpnName = ""  
Name text displayed in the HUD for this Weapon. This is passed through the Localization Table.  
    
wpnIcon = ""  
Texture filename for the weapon's Icon. Such as Jetpack uses.  
    
wpnReticle = ""  
Sprite Table name for this weapon's Reticle icon.  
    
wpnCategory = ""  
This is a 4 letter abbreviation for this weapon's Category type. This controls which Hard Points it can fit into on an object's weaponName Slots. Valid values are:  
   * GUN  
   * CANN  
   * ROCK  
   * MORT  
   * SPEC  
   * SHIE  
   * HAND  
   * PACK  
    
isAssault = false  
If this is true, this weapon can only fit into weapon Hard Points with weaponAssault set to true.  
    
isFlying = false  
If this is true, flags it as isFlying. If a PersonClass object is equipped with this weapon set as true, it will use "Assault Mode" animation (StandA, WalkA, CrouchA, JumpA, DeathA).  
    
needLOS = true  
If this is false, doesn't need line of sight for AI's AbleToHit to check return true.  
    
AllowAimHigh = true  
If false, won't allow high arching shots.  
    
canSelect = true  
If false, can't be selected when cycling through Weapon Slots.  
_Note:_ ShieldUpgradeClass defaults to false.  
    
ShowShotsRemaining = true  
If this is false, won't show the shots left on a per-weapon basis.  
    
aiRange = ordnance Range.  
The range which AI will fire this weapon from, if their SubAttackClass is set to use Weapon Range. If this is not specified, it calculates it from the Ordnance class's lifespan\*shotSpeed.  
_Note:_ The Default for some Classes are: TorpedoLauncher: 120.0f, SpecialItemClass: 10.0f, RadarLauncherClass: 120.0f, MortarClass: 100.0f, DispenserClass: 50.0f  
Note: If there is a valid ordName, this property does not Inherit from classLabel ODF, it uses the ordnance lifetime instead of root ODF's property.  
    
localAmmo = 0  
This is a special amount of Ammo this weapon contains Locally. This is separate from an object's maxAmmo reserve.  
    
addLocalAmmo = 0  
Amount of Local Ammo generated per second.  
    
LeadPositionMinTime = 0.0f  
Minimum amount of time it will lead the shot.  
    
LeadPositionMaxTime = 60.0f  
Maximum amount of time it will lead the shot.  
    
MinOwnerLifetimeSeconds = -1.0f  
Minimum time in seconds the owner must be alive before weapon can trigger.  
    
MaxOwnerLifetimeSeconds = -1.0f  
Maximum time in seconds the owner can be alive before weapon cannot trigger.  
    
AllowedOwnerStateMask = 15  
Mask for what State the user has to be in to fire this weapon. Valid values are:  
   * 1 = Undeployed  
   * 2 = Deploying  
   * 4 = Deployed  
   * 8 = Undeploying  
    
CouldHit = true  
If this is false, AI won't try to use this weapon. Default is false for Class: ShieldUpgrade.  
    
AllowOffmapFiring = false  
If this is true, weapon can be fired from outside the map boundary.  
    
**Weapon Visual Mesh.**  
If this is specified, and there is a visualHard on the Weapon Hard point, this is the model that is attached there. Used by Pilot weapons for their external and cockpit geometry, but can be applied to any weapon.  
geometryName = ""  
This object's Model file name. Can be .XSI or .FBX.  
    
geometryScale = 1.0f  
This model's Scale.  
_Note:_ Skinned meshes do not scale well.  
    
animCount = 0  
Number of Animations to load for this object.  
    
animName1 ... animName# = ""  
Name for Animation. Some classes play animations on their own. See list of supported AnimNames for each Class.  
    
animFile1 ... animFile# = ""  
Model file name for the specified Animation. Can be .XSI or .FBX  
_Note:_ You can use .XSI files with a .FBX geometryName, as long as the hierarchy matches.  
    
cockpitName = ""  
Model file name for the Cockpit model. Can be .XSI or .FBX  
    
cockpitScale = 1.0  
Scale for Cockpit Model.  
    
animCountCockpit = 0  
Number of Animations to load for Cockpit model.  
    
animNameCockpit1 ... animNameCockpit# = ""  
Name for Animation. See list of supported AnimNames for each Class.  
    
animFileCockpit1 ... animFileCockpit# = ""  
Model file name for the specified Animation. Can be .XSI or .FBX  
_Note:_ You can use .XSI files with a .FBX cockpitName, as long as the hierarchy matches.

 ArcCannonClass 

 Classlabel: "arccannon"  
  
**Class Tree: Entity->Weapon->ArcCannon**  
  
**Description:**  
Arc Cannon is a weapon that creates a stream extending forward from the vehicle. It locks onto Targets within the forward view.  
  
**ODF Properties:**  
* **\[ArcCannonClass\]**  
    
salvoDelay = 0.1f  
Minimum time in seconds between shots.  
    
startDist = 10.0f  
The starting distance from the ship.  
    
finishDist = 100.0f  
The maximum distance from the ship it will reach.  
    
travelVeloc = 20.0f  
How far it travels between StartDist and FinishDist per second.  
    
coneAngle = 0.1f  
Cone Angle for target selection.  
    
ammoCost = 0  
Ammo cost per second.  
    
damageValue(N) = 0  
Damage value done to objects with no Shield and Armor class N.  
    
damageValue(L) = 0  
Damage value done to objects with no Shield and Armor class L.  
    
damageValue(H) = 0  
Damage value done to objects with no Shield and Armor class H.  
    
damageValue(S) = 0  
Damage value done to objects with Shield class S.  
    
damageValue(D) = 0  
Damage value done to objects with Shield class D.  
    
damageValue(A) = 0  
Damage value done to objects with Shield class A.  
    
activeSound = ""  
Sound file played while active.  
    
xplGround = ""  
ODF name for the Explosion Class for hitting the Ground.  
    
xplVehicle = ""  
ODF name for the Explosion Class for hitting a Craft.  
    
xplPerson = ""  
ODF name for the Explosion Class for hitting a Person. Defaults to xplVehicle if not specified.  
    
xplBuilding = ""  
ODF name for the Explosion Class for hitting a Building.

 BlinkDeviceClass 

 Classlabel: "blink"  
  
**Class Tree: Entity->Weapon->BlinkDevice**  
  
**Description:**  
Blink Device allows the user to Teleport to a spot on the surface where their Reticle is pointing.  
  
**ODF Properties:**  
* **\[BlinkDeviceClass\]**  
    
ammoBase = 100.0f  
Base ammo cost to Teleport, regardless of Distance.  
    
ammoDist = 10.0f  
Ammo cost multiplier for use in calculating how much distance costs.  
    
groundSprite = ""  
Sprite Table name for the Ground Reticle that appears at the destination position.  
    
groundSpriteColor = "0 255 0 255"  
Color value for the Ground Sprite indicator.  
    
xplExit = ""  
ODF of the Explosion Class used at the Destination location.  
    
xplEnter = ""  
ODF of the Explosion Class used at the Start location.  
    
shotDelay = 0.0f  
Time in seconds before it can be fired again.  
    
InitialShotDelay = 0.0f  
Minimum time trigger must be held down before it will activate.

 CannonClass 

 Classlabel: "cannon"  
  
**Class Tree: Entity->Weapon->Cannon**  
  
**Description:**  
Cannon fires an Ordnance Class object forward.  
  
**ODF Properties:**  
* **\[CannonClass\]**  
    
shotDelay = 0.2f  
Time in seconds before it can be fired again.  
    
InitialShotDelay = 0.0f  
Minimum time trigger must be held down before it will activate.  
    
salvoCount = 1  
This is how many shots fire each time the Weapon is fired.  
    
salvoDelay = 0.0f  
If SalvoCount is > 0, this is the time in seconds between Salvo shots.  
    
shotVariance = 0.0f  
The amount of randomized cone angle variance applied to the ordnance's trajectory.  
    
shotPitch = 0.0f  
The initial Pitch that the Ordnance is launched at. 0 is straight forward, 1.5707 is straight Up, etc.  
    
forceId = ""  
Character ID of the Force Feedback effect? Depreciated Jaystick Force Feedback stuff.  
    
shotAlternate = false  
If this is true, and there are multiple, Grouped Weapon Hard points with this weapon, it alternates the firing between each Hard point. ShotDelay is divided evenly between the amount of Hard Points.  
    
shotLead = true  
If this is false, the AI won't try to aim ahead if the Target is moving.  
    
setMissileTarget = false  
If this is true, and the ordName is a Missile Class, it passes the owner's Target object as the Missile's Target.  
    
OnlyOneSound = false  
If this is true, only one instance of fireSound can be playing at a time, if one is still playing from the previous shot fired, it squelches it with another.  
    
SoundPerShot = 1  
This is a setting for which Sound mode it uses for fireSound. Valid values are: 0 = Looping, 1 = One instance per shot, 2 = Only one instance at a time. 2 is effectively the same as OnlyOneSound.

 ChargeGunClass 

 Classlabel: "chargegun"  
  
**Class Tree: Entity->Weapon->Cannon->ChargeGun**  
  
**Description:**  
Charge Gun is a type of cannon that can fire different Ordnance based on how long the trigger is held down.  
  
**ODF Properties:**  
* **\[ChargeGunClass\]**  
    
startRate = 11025.0f  
Starting play rate for the fireSound.  
    
deltaRate = 4000.0f  
Multiplier for how much the fireSound rate changes as the trigger is held down.  
    
startVolume = 1.0f  
Volume multiplier for initial volume of fireSound.  
    
deltaVolume = 0.0f  
Multiplierfor how much Volume changes as the trigger is held down.  
    
ordnanceCount = 1  
How many different Ordnance stages it goes through as trigger is held.  
    
holdRate = 100.0f  
How much Ammo is drained per second while holding down the Trigger when fully charged.  
    
For each Ordnance Count:  
salvoCount1 ... salvoCount# = 1  
SalvoCount for this Charge.  
    
shotDelay1 ... shotDelay# = 0.0f  
Salvo Delay for this Charge.  
    
salvoDelay = 0.0f  
SalvoDelay for this Charge.  
    
shotVariance = 0.0f  
ShotVariance for this Charge.  
    
fireSound = ""  
fireSound for this Charge.  
    
ordName = ""  
odfName for this Charge.  
    
wpnReticle = ""  
wpnReticle for this Charge.

 DamageFieldClass 

 Classlabel: "damagefield"  
  
**Class Tree: Entity->WeaponClass->DamageField**  
  
**Description:**  
Damage Field damages objects nearby while the trigger is held.  
  
**ODF Properties:**  
* **\[DamageFieldClass\]**  
    
ammoCost = 0.0f  
Ammo cost per second while active.  
    
damageRadius = 0.0f  
Radius around the carrier that the damage is applied.  
    
damageValue(N) = 0  
Damage value done to objects with no Shield and Armor class N.  
    
damageValue(L) = 0  
Damage value done to objects with no Shield and Armor class L.  
    
damageValue(H) = 0  
Damage value done to objects with no Shield and Armor class H.  
    
damageValue(S) = 0  
Damage value done to objects with Shield class S.  
    
damageValue(D) = 0  
Damage value done to objects with Shield class D.  
    
damageValue(A) = 0  
Damage value done to objects with Shield class A.  
    
activeSound = ""  
Sound file played while active.  
    
TeamFilter = 0  
Team filter for what teams it can damage. Valid values: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies, 4 = not same team  
    
DamageOwner = false  
If this is true, it also damages the carrier.

 DispenserClass 

 Classlabel: "dispenser"  
  
**Class Tree: Entity->Weapon->Dispenser**  
  
**Description:**  
Dispenser Class can drop a Game Object, such as a Mine.  
  
**Default ODF Properties:**  

\[WeaponClass\] aiRange = 50.0f

  
**ODF Properties:**  
* **\[DispenserClass\]**  
    
objectClass = ""  
ODF name of the GameObject Class to drop.  
    
shotDelay = 0.0f  
Time in seconds before it can be fired again.  
    
InitialShotDelay = 0.0f  
Minimum time trigger must be held down before it will activate.  
    
DispenseOnGround = -1  
If this object is Dispensed at the current Height, or on Ground level. 0 is False, 1 is true. -1 Defaults to true for IDClass: Craft, Vehicle, Torpedoes, Powerups, Person, and Animals, and False for everything else.

 ForceFieldClass 

 Classlabel: "forcefield"  
  
**Class Tree: Entity->Weapon->SpecialItem->ForceField**  
  
**Description:**  
ForceField Class is a Toggle weapon that converts incoming Damage into Ammo cost, effectively expending Ammo or LocalAmmo to negate Damage.  
  
**ODF Properties:**  
* **\[ForceFieldClass\]**  
    
ammoScale = 1.0f  
Scale for Damage conversion into Ammo cost.  
    
renderName = ""  
Render used when this object receives Damage.  
    
soundAbsorb = ""  
Sound file played when this object receives Damage.

 ImageLauncherClass 

 Classlabel: "imagelauncher"  
  
**Class Tree: Entity->Weapon->Launcher->ImageLauncher**  
  
**Description:**  
Image Launcher is a lock on Launcher that locks onto the Image signature. 

 ImageRefract 

 Classlabel: "imagerefract"  
  
**Class Tree: Entity->SpecialItem->ImageRefract**  
  
**Description:**  
Image Refract is a Special Item class that makes the user visually invisible while active. 

 JetPackClass 

 Classlabel: "jetpack"  
  
**Class Tree: Entity->Weapon->JetPack**  
  
**Description:**  
Jet Pack is a weapon that applies Thrust for a period of time.  
  
**ODF Properties:**  
* **\[JetPackClass\]**  
    
burnTime = 10.0f  
How long it applies Thrust.  
    
ammoCost = 1.0f  
Ammo cost of firing this weapon. If burnTime is > 0, it is an initial cost, if it is <= 0 it is cost per second.  
    
accelThrust = 20.0f  
Vertical Thrust applied.  
    
ForwardThrust = 0.0f  
Forward Thrust applied.  
    
MaxVelocity = 1e6  
Maximum velocity before Thrust no longer has an effect.  
    
setAltitude = 0.0f  
If this is > 0, Thrust loses effectiveness above this altitude.  
    
activeSound = ""  
Sound file played while Active.  
    
expireSound = ""  
Sound file played upon expiration.

 LauncherClass 

 Classlabel: "launcher"  
  
**Class Tree: Entity->Weapon->Launcher**  
  
**Description:**  
Launcher is a Lock On and Release type of weapon.  
  
**ODF Properties:**  
* **\[LauncherClass\]**  
    
shotDelay = 0.0f  
Time in seconds before it can be fired again.  
    
InitialShotDelay = 0.0f  
Minimum time trigger must be held down before it will activate.  
    
lockRange = 0.0f  
How far it can lock onto objects.  
    
lockDelay = 5.0f  
Time it takes to fully lock on.  
    
coneAngle = 1.5707  
Cone angle for locking onto Targets.  
    
lockingSound = ""  
Sound file played while Locking On.  
    
lockedSound = ""  
Sound file played when Locked On.  
    
targetCount = 0  
How many stages the targetReticle uses.  
    
targetReticle = ""  
Sprite Table name for the Locking Reticle. This reticle has a .0 appended, and increments the number for each Count.  
    
TeamFilter = 0  
Team Filter for Locking On. Valid values are: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies, 4 = not same team

 MachineGunClass 

 Classlabel: "machinegun"  
  
**Class Tree: Entity->Weapon->Cannon->MachineGun**  
  
**Description:**  
MchineGun is a type of Cannon that defaults to SoundPerShot of 0 (looping) and also supports the Rave Gun's Flash Fx.  
  
**Default ODF Properties:**  

\[CannonClass\] shotDelay = 0.2f soundPerShot = 0

 MagnetGunClass 

 Classlabel: "magnetgun"  
  
**Class Tree: Entity->Wepaon->MagnetGun**  
  
**Description:**  
Magnet Gun Class is a weapon that can push things while Active.  
  
**ODF Properties:**  
* **\[MagnetGunClass\]**  
    
ammoCost = 10.0f  
Ammo cost per second.  
    
activeSound = ""  
Sound file played while Active.  
    
coneAngle = 0.3f  
Cone angle for the Field.  
    
fieldRadius = 20.0f  
How far the field extends outward.  
    
objPushCenter = 30.0f  
Object push force at Center of field.  
    
objPushEdge = 3.0f  
Object push force at Edge of field.  
    
objDragCenter = 0.0f  
Object Drag at Center of field.  
    
objDragEdge = 0.0f  
Object Drag at Edge of field.  
    
objDrag = ObjDragCenter.  
If this is set, it is used for both objDragCenter and objDragEdge, and overrides those settings.  
    
ordPushCenter = 100.0f  
Ordnance push force at Center of field.  
    
ordPushEdge = 10.0f  
Ordnance push force at Edge of field.  
    
ordDragCenter = 0.0f  
Ordnance Drag at Center of field.  
    
ordDragEdge = 0.0f  
Ordnance Drag at Edge of field.  
    
ordDrag = OrdDragCenter.  
If this is set, it is used for both ordDragCenter and ordDragEdge , and overrides those settings.  
    
TeamFilter = 0  
Team Filter for what Teams to affect. Valid values are: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies  
    
UseCone = true  
If this is false, it doesn't use the coneAngle and just uses Radius.  
    
ForceMass = -1  
If this is < 0, default behavior is applied. If this is > 0, then the Force applied to the object is multiplied by (ForceMass / Target's Mass).  
    
MinForceMassScale = 0.0001  
If ForceMass is > 0, this is the minimum mass it clamps to.  
    
MaxForceMassScale = 1.0  
If ForceMass is > 0, this is the maximum mass it clamps to.

 MortarClass 

 Classlabel: "mortar"  
  
**Class Tree: Entity->Weapon->Cannon->Mortar**  
  
**Description:**  
Mortar is a Cannon that has different Defaults.  
  
**Default ODF Properties:**  

\[WeaponClass\] aiRange = 100.0f \[CannonClass\] shotDelay = 1.0f

 MultiLauncherClass 

 Classlabel: "multilauncher"  
  
**Class Tree: Entity->Weapon->Launcher->ImageLauncher->MultiLauncher**  
  
**Description:**  
Multi Launcher is a type of ImageLauncher that can make multiple Locks, optionally to multiple targets. It fires at each target.  
  
**ODF Properties:**  
* **\[MultiLauncherClass\]**  
    
targetCount = 5  
How many Locks it can make.  
    
loseAngle = 1.5707  
Cone angle which the target lock is lost.

 RadarDamperClass 

 Classlabel: "radardamper"  
  
**Class Tree: Entity->Weapon->SpecialItem->RadarDamper**  
  
**Description:**  
Radar Damper is a weapon that hides the carrier on Radar while Active. 

 RadarLauncherClass 

 Classlabel: "radarlauncher"  
  
**Class Tree: Entity->Weapon->Launcher->RadarLauncher**  
  
**Description:**  
Radar Launcher is a Launcher that Locks onto objects based on Radar signature.  
  
**Default ODF Properties:**  

\[WeaponClass\] aiRange = 120.0f

 RemoteDetonatorClass 

 Classlabel: "detonator"  
  
**Class Tree: Entity->Weapon>Mortar->RemoteDetonator**  
  
**Description:**  
Remote Detonator is a weapon that can be Toggled to detonate it at will. It is used by the MDM Mortar.  
  
**ODF Properties:**  
* **\[RemoteDetonatorClass\]**  
    
armedReticle = ""  
Sprite Table name for the weapon reticle used while this weapon is Armed.  
    
maxCount = 4  
Maximum number of Ordnance that can be Armed at a time. Max is 8.

 SalvoLauncherClass 

 Classlabel: "salvo"  
  
**Class Tree: Entity->Weapon->SalvoLauncher**  
  
**Description:**  
Salvo Launcher is a weapon that can use SalvoCount, and passes the carrier's currently Targeted object to a Missile. It also updates it's reticle while Targeted and while firing.  
  
**ODF Properties:**  
* **\[SalvoLauncherClass\]**  
    
shotDelay = 0.2f  
Time in seconds before it can be fired again.  
    
InitialShotDelay = 0.0f  
Minimum time trigger must be held down before it will activate.  
    
salvoCount = 1  
This is how many shots fire each time the Weapon is fired.  
    
salvoDelay = 0.0f  
If SalvoCount is > 0, this is the time in seconds between Salvo shots.  
    
shotVariance = 0.0f  
The amount of randomized cone angle variance applied to the ordnance's trajectory.  
    
shotPitch = 0.0f  
The initial Pitch that the Ordnance is launched at. 0 is straight forward, 1.5707 is straight Up, etc.  
    
shotLead = true  
If this is false, the AI won't try to aim ahead if the Target is moving.  
    
armedReticle = ""  
Sprite Table name for the reticle used while there is a valid Target selected via the Target key bind.  
    
busyReticle = ""  
Sprite Table name for the reticle used while this object is firing it's SalvoCount.

 SatchelPackClass 

 Classlabel: "satchelpack"  
  
**Class Tree: Entity->Weapon->SatchelPack**  
  
**Description:**  
SatchelPack is a weapon that is similar to Dispenser class, but it can place the object onto the surface of a building.  
  
**ODF Properties:**  
* **\[SatchelPackClass\]**  
    
objectClass = ""  
ODF name of the GameObject Class to drop.  
    
shotDelay = 1.0f  
Time in seconds before it can be fired again.  
    
InitialShotDelay = 0.0f  
Minimum time trigger must be held down before it will activate.  
    
maxRange = 2.0f  
Maximum range from an object for it to try to snap to it.

 ShieldUpgradeClass 

 Classlabel: "shieldup"  
  
**Class Tree: Entity->Weapon->ShieldUpgrade**  
  
**Description:**  
Shield upgrade class is a weapon that equips the carrier with a ShieldClass. This changes what type of Damage value is applied to it.  
  
**Default ODF Properties:**  

\[WeaponClass\] canSelect = false couldHit = false

  
**ODF Properties:**  
* **\[ShieldUpgradeClass\]**  
    
shieldClass = "S"  
    
colorRange = 0.5f  
Color Range multiplier that the effect Starts at based on damage.  
    
animateTime = 1.0f  
Time it takes for the effect to render.  
    
scaleStart = 0.1f  
Start size.  
    
scaleFinish = 1.0  
Finish size.  
    
startColor = "255 255 255 255"  
Starting color.  
    
middleColor = "255 255 255 255"  
Middile color.  
    
finishColor = "255 255 255 255"  
Finish color.  
    
textureName = ""  
Texture filename used for the Shield Effect.

 SpecialItemClass 

 Classlabel: "specialitem"  
  
**Class Tree: Entity->Weapon->SpecialItem**  
  
**Description:**  
Special Item Class is a weapon that is toggled on and off.  
  
**Default ODF Properties:**  

\[WeaponClass\] aiRange = 10.0f

  
**ODF Properties:**  
* **\[SpecialItemClass\]**  
    
activeSound = ""  
Sound file played while Active.  
    
expireSound = ""  
Sound file played upon expiration.  
    
ammoCost = 100  
Ammo cost per second while Active.

 TargetingGunClass 

 Classlabel: "targeting"  
  
**Class Tree: Entity->Weapon->TargetingGun**  
  
**Description:**  
Targeting Gun Class is a weapon that fires a Leader round class.   
  
**ODF Properties:**  
* **\[TargetingGunClass\]**  
    
leaderName = ""  
ODF name for the Leader round Ordnance Class.  
    
leaderSound = ""  
Sound file played when firing the Leader round.  
    
shotDelay = 1.0f  
Time in seconds before it can be fired again.  
    
InitialShotDelay = 0.0f  
Minimum time trigger must be held down before it will activate.  
    
salvoCount = 10  
This is how many shots fire each time the Weapon is fired.  
    
firstDelay = 1.0f  
Initial shotDelay between the Leader hitting an object and the Salvo starting.  
    
salvoDelay = 0.2f  
If SalvoCount is > 0, this is the time in seconds between Salvo shots.  
    
lockingReticle = ""  
Sprite Table name for the reticle used while the Leader round is active.  
    
lockedReticle = ""  
Sprite Table name for the reticle used while the Leader round is locked onto a target.

 TerrainExposeClass 

 Classlabel: "terrainexpose"  
  
**Class Tree: Entity->Weapon->SpecialItem->TerrainExpose**  
  
**Description:**  
Terrain Expose is a SpecialItem that enables a Wireframe view of Terrain while Active. 

 ThermalLauncherClass 

 Classlabel: "thermallauncher"  
  
**Class Tree: Entity->Weapon->Launcher->ThermalLauncher**  
  
**Description:**  
Thermal Launcher is a Launcher that locks onto the Heat signature of an object. 

 TorpedoLauncherClass 

 Classlabel: "torpedolauncher"  
  
**Class Tree: Entity->Weapon->Launcher->TorpedoLauncher**  
  
**Description:**  
Torpedo Launcher is a Launcher that can launch a GameObject Class similar to a Dispenser.  
  
**Default ODF Properties:**  

\[WeaponClass\] aiRange = 120.0f

  
**ODF Properties:**  
* **\[TorpedoLauncherClass\]**  
    
objectClass = ""  
ODF name of the GameObject Class that is Dispensed.

 OrdnanceClass 

 Classlabel: "ordnance"  
  
**Class Tree: Entity->Ordnance**  
  
**Description:**  
Ordnance is the root class for all the Entities launched by WeaponClass ordName.   
  
**ODF Properties:**  
* **\[OrdnanceClass\]**  
    
shotGeometry = ""  
This Ordnance's Model file name. Can be .XSI or .FBX.  
    
shotScale = 1.0f  
This model's Scale.  
_Note:_ This is used instead of geometryScale for shotGeometry.  
    
shotRadius = 0.0f  
The radius that this Ordnance can impact something. Basically it's collision radius size.  
_Note:_ This ODF parameter is **NOT** supported by ODF Inheritance.  
    
LifespanBeforeCollidesWithOwner = 0.2f  
How long it must exist before it can Collide with the object that shot it.  
    
shotSound = ""  
Sound file played by this Ordnance.  
    
xplGround = ""  
ODF name for the Explosion Class for hitting the Ground.  
    
xplVehicle = ""  
ODF name for the Explosion Class for hitting a Craft.  
    
xplPerson = ""  
ODF name for the Explosion Class for hitting a Person. Defaults to xplVehicle if not specified.  
    
xplBuilding = ""  
ODF name for the Explosion Class for hitting a Building.  
    
xplExpire = ""  
ODF name for the Explosion Class for when this Ordnance expires before hitting something.  
    
ammoCost = 0  
Ammo cost per second.  
    
lifeSpan = 1e30  
Time in seconds this ordnance exists.  
    
shotSpeed = 0.0f  
Speed in m/s of this ordnance.  
_Note:_ The aiRange of the WeaponClass defaults to lifeSpan \* shotSpeed.  
    
IsArcing = false  
If this is true, the AI will aim higher.  
    
LeadPositionMinTime = 0.0f  
Minimum amount of time it will lead the shot. Used by Popper/RadarPopper class.  
    
LeadPositionMaxTime = 60.0f  
Maximum amount of time it will lead the shot. Used by Popper/RadarPopper class.  
    
renderName = ""  
Render effect name for this Ordnance.  
    
RestoreFxSavegame = true RestoreFxLockstep = false RestoreFxVisual = true  
Flags for if the Render Effect is restored on various Load states. Savegame is on a .sav load. Lockstep is SP. Visual is MP.  
    
damageValue(N) = 0  
Damage value done to objects with no Shield and Armor class N.  
    
damageValue(L) = 0  
Damage value done to objects with no Shield and Armor class L.  
    
damageValue(H) = 0  
Damage value done to objects with no Shield and Armor class H.  
    
damageValue(S) = 0  
Damage value done to objects with Shield class S.  
    
damageValue(D) = 0  
Damage value done to objects with Shield class D.  
    
damageValue(A) = 0  
Damage value done to objects with Shield class A.

 AnchorRocketClass 

 Classlabel: "anchor"  
  
**Class Tree: Entity->Ordnance->LeaderRound->AnchorRound**  
  
**Description:**  
Anchor Round is an Ordnance that slows down the object it sticks to.  
  
**ODF Properties:**  
* **\[AnchorRocketClass\]**  
    
accelDrag = 10.0f  
Velocity Drag applied to the object.  
    
alphaDrag = 5.0f  
Turn Drag applied to the object.  
    
TeamFilter = 0  
Team Filter for what Teams to affect. Valid values are: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies

 BeamClass 

 Classlabel: "beam"  
  
**Class Tree: Entity->Bullet->Beam**  
  
**Description:**  
Beam is a type of Bullet that has the following defaults.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 1 lifeSpan = 200e-6f shotSpeed = 1e6

 BounceBombClass 

 Classlabel: "bouncebomb"  
  
**Class Tree: Entity->Ordnance->Bullet->Grenade->BounceBomb**  
  
**Description:**  
Bounce Bomb is a Grenade that bounces off surfaces.  
  
**ODF Properties:**  
* **\[BounceBombClass\]**  
    
bounceRatio = 0.5f  
Amount of velocity retained after it bounces.  
    
bounceSound = "bounce.wav"  
Sound file played when it bounces.

 BulletClass 

 Classlabel: "bullet"  
  
**Class Tree: Entity->Ordnance->Bullet**  
  
**Description:**  
Bullet is a type of Ordnance Class most commonly used. It defaults to the following:  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 1 lifeSpan = 5.0f shotSpeed = 200.0f

 GrenadeClass 

 Classlabel: "grenade"  
  
**Class Tree: Entity->Ordnance->Bullet->Grenade**  
  
**Description:**  
Grenade is an Ordnance class that arcs with Gravity. It has the following Defaults:  
  
\[OrdnanceClass\] ammoCost = 10 lifeSpan = 1e30 shotSpeed = 50.0f IsArcing = true

 ImageMissileClass 

 Classlabel: "imagemissile"  
  
**Class Tree: Entity->Ordnance->Bullet->Missile->ImageMissile**  
  
**Description:**  
Image Missile is a missile that can't lock onto a Target that is using ImageRefract class. (Phantom VIR)  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10 \[MissileClass\] omegaTurn = 1.0f

 LaserMissileClass 

 Classlabel: "lasermissile"  
  
**Class Tree: Entity->Ordnance->Missile->LaserMissile**  
  
**Description:**  
Laser Missile is a Missile that homes in on where the owner's Reticle is pointing.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10 \[MissileClass\] omegaTurn = 1.0f

 LaserPopperClass 

 Classlabel: "laserpopper"  
  
Class Tree: Entity->Ordnance->Bullet->Grande->LaserPopper  
  
Laser Popper is a Grenade that launches an Ordnance towards where the owner's Target reticle is aiming as soon as it starts falling.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10

  
**ODF Properties:**  
* **\[LaserPopperClass\]**  
    
launchOrd = ""  
ODF name of the Ordnance Class launched by this Popper.  
    
launchXpl = ""  
ODF name of the Explosion Class used when this ordnance launches it's launchOrd.

 LeaderRoundClass 

 Classlabel: "leader"  
  
**Class Tree: Entity->Ordnance->Bullet->LeaderRound**  
  
**Description:**  
Leader Round is an Ordnance that sticks to the object it hits. It can apply damage over time to the object it sticks to.  
  
**ODF Properties:**  
* **\[LeaderRoundClass\]**  
    
stickTime = 2.0f  
How long it sticks to the object it hits.  
    
damageValue(N) = 0  
Damage value done to objects with no Shield and Armor class N per second while stuck.  
    
damageValue(L) = 0  
Damage value done to objects with no Shield and Armor class L per second while stuck.  
    
damageValue(H) = 0  
Damage value done to objects with no Shield and Armor class H per second while stuck.  
    
damageValue(S) = 0  
Damage value done to objects with Shield class S per second while stuck.  
    
damageValue(D) = 0  
Damage value done to objects with Shield class D per second while stuck.  
    
damageValue(A) = 0  
Damage value done to objects with Shield class A per second while stuck.  
    
xplDone = ""  
ODF name of the Explosion Class used when stickTime expires.

 LockShellClass 

 Classlabel: "lockdown"  
  
**Class Tree: Entity->Ordnance->Bullet->LockShell**  
  
**Description:**  
LockShell class is an ordnance that can trigger the Lockdown effect on an object. Lockdown disables firing weapons and turns off Power to the object it hits.  
  
**ODF Properties:**  
* **\[LockShellClass\]**  
    
Lifespan = 0.1f  
How long the Lockdown effect lasts.

 MagnetShellClass 

 Classlabel: "magnetshell"  
  
**Class Tree: Entity->Ordnance->Bullet->MagnetShell**  
  
**Description:**  
Magnet Shell class is an Ordnance that has a Magnet Field.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10 lifeSpan = 1e30 shotSpeed = 50.0f

  
**ODF Properties:**  
* **\[MagnetShellClass\]**  
    
triggerDelay = 0.5f  
Time in seconds before it starts emitting ordnance/damage.  
    
fieldRadius = 20.0f  
How far the field extends outward.  
    
objPushCenter = 30.0f  
Object push force at Center of field.  
    
objPushEdge = 3.0f  
Object push force at Edge of field.  
    
objDragCenter = 0.0f  
Object Drag at Center of field.  
    
objDragEdge = 0.0f  
Object Drag at Edge of field.  
    
objDrag = ObjDragCenter.  
If this is set, it is used for both objDragCenter and objDragEdge, and overrides those settings.  
    
ordPushCenter = 100.0f  
Ordnance push force at Center of field.  
    
ordPushEdge = 10.0f  
Ordnance push force at Edge of field.  
    
ordDragCenter = 0.0f  
Ordnance Drag at Center of field.  
    
ordDragEdge = 0.0f  
Ordnance Drag at Edge of field.  
    
ordDrag = OrdDragCenter.  
If this is set, it is used for both ordDragCenter and ordDragEdge , and overrides those settings.  
    
TeamFilter = 0  
Team Filter for what Teams to affect. Valid values are: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies  
    
ForceMass = -1  
If this is < 0, default behavior is applied. If this is > 0, then the Force applied to the object is multiplied by (ForceMass / Target's Mass).  
    
MinForceMassScale = 0.0001  
If ForceMass is > 0, this is the minimum mass it clamps to.  
    
MaxForceMassScale = 1.0  
If ForceMass is > 0, this is the maximum mass it clamps to.

 MissileClass 

 Classlabel: "missile"  
  
Class Tree: Entity->Ordnance->Bullet->Missile  
  
**Description:**  
Missile is an Ordnance that can apply it's own Thrust and home in on a Target.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10

  
**ODF Properties:**  
* **\[MissileClass\]**  
    
velocForward = shotSpeed  
Forward velocity applied by Thrust.  
    
accelThrust = 100.0f  
Acceleration from Thrusting.  
    
delayTime = 0.0f  
Time in seconds before it begins homing.  
    
rampTime = 0.0f  
Time in seconds it takes to reach full homing turn speed.  
    
omegaTurn = 1.0f  
Turn speed.  
    
omegaWaver = 0.0f  
How much it's heading Wavers.  
    
rateWaver = 0.0f  
How fast it's heading Wavers.  
    
TeamFilter = 0  
Team Fitler for choosing Targets. Used by LaserMissile and ThermalMissile. Valid values: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies, 4 = not same team  
    
avoidRange = 0.0f  
Range that it tries to Avoid obstacles such as Terrain.  
    
avoidStrength = 0.0f  
How much it Steers to avoid Terrain.

 PopperClass 

 Classlabel: "popper"  
  
**Class Tree: Entity->Ordnance->Bullet->Grenade->Popper**  
  
**Description:**  
Popper is a Grenade that launches another Ordnance when it starts falling or it's lifeSpan expires.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10

  
**ODF Properties:**  
* **\[PopperClass\]**  
    
scanRange = 100.0f  
Range the Popper will search for Targets.  
    
targetAngle = 3.14159  
    
aimAngle = 3.14159  
    
TargetHidden = -1  
If this is >= 0, it is used to check if the Popper targets MorphTanks with HiddenWhenMorphed while Deployed. 0 is false, 1 is true.  
    
TargetInteractable = -1  
If this is >= 0, it is used to check if the Popper targets objects that are Interactable. 0 is false, 1 is true.  
    
TeamFilter = 0  
Team Filter for what objects the Popper can Target. Valid values: 0 = all teams, 1 = same team only, 2 = allies, 3 = enemies, 4 = not same team  
    
launchOrd = ""  
ODF name of the Ordnance Class launched by this Popper.  
    
launchXpl = ""  
ODF name of the Explosion Class used when this ordnance launches it's launchOrd.

 PulseShellClass 

 Classlabel: "pulse"  
  
**Class Tree: Entity->Ordnance->Bullet->Pulse**  
  
**Description:**  
Pulse Shell is an Ordnance that emits an Explosion periodically. It can also pass through objects if it's shotRadius is negative.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10 lifeSpan = 1e30 shotSpeed = 50

  
**ODF Properties:**  
* **\[PulseShellClass\]**  
    
pulseDelay = 1.0f  
Time in seconds before it begins emitting Pulses.  
    
pulsePeriod = 0.5f  
Interval between Pulses.  
    
xplPulse = ""  
ODF name for the Explosion Class emitted each Pulse.

 RadarMissileClass 

 Classlabel: "radarmissile"  
  
**Class Tree: Entity->Ordnance->Bullet->Missile->RadarMissile**  
  
**Description:**  
Radar Missile is a missile that can't lock onto a Target that is using RadarDampen class. (Red Field)  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10 \[MissileClass\] omegaTurn = 1.0f

 RadarPopperClass 

 Classlabel: "radarpopper"  
  
Class Tree: **Entity->Ordnance->Bullet->Grande->RadarPopper**  
  
**Description:**  
Radar Popper is a Grenade that launches an Ordnance towards the owner's current Target as soon as it begins falling.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10

  
**ODF Properties:**  
* **\[RadarPopperClass\]**  
    
launchOrd = ""  
ODF name of the Ordnance Class launched by this Popper.  
    
launchXpl = ""  
ODF name of the Explosion Class used when this ordnance launches it's launchOrd.

 SeismicWaveClass 

 Classlabel: "seismic"  
  
**Class Tree: Entity->Ordnance->SeismicWave**  
  
**Description:**  
SeismicWave generates a Wave across the Terrain that disorients objects in it's path.  
  
**ODF Properties:**  
* **\[SeismicWaveClass\]**  
    
waveRadius = 50.0f  
Radius of the Wave.  
    
waveHeight = 6.0f  
Height of the Wave.  
    
waveFrontFrequency = 1.0f  
How much of the Wave front dips.  
    
rampUpTime = 5.0f  
Time in seconds until it reaches full Height.  
    
rampDownTime = 2.0f  
Time in seconds it takes to reduce height back to 0.  
    
sweepOmega = 100.0f  
Sweep rotational velocity to spin units as the wave moves past.  
    
sweepVeloc = 50.0f  
Sweep linear velocity to push units along with the wave.  
    
shakeFrequency = 3.0f  
The frequency of the noise used by the shake effect.  
    
shakeOmega = 2.0f  
Shake rotational velocity to spin units randomly.  
    
shakeVeloc = 5.0f  
Shake linear velocity to push units randomly.  
    
dampOmega = 0.0f  
Rotational damping force to keep units from spinning.  
    
levelOmega = 0.0f  
Rotational leveling force to keep units from flipping.  
    
buildingScale = 1.0f  
Multiplier applied to Damage done to Buildings.

 SniperShellClass 

 Classlabel: "snipershell"  
  
**Class Tree: Entity->Ordnance->Bullet->SniperShell**  
  
**Description:**  
Sniper Shell is an Ordnance that can kill the Pilot of a craft if it hits within a certain Radius and Distance of the hp\_eyepoint dot.  
  
**ODF Properties:**  
* **\[SniperShellClass\]**  
    
killLength = 3.0f  
How far into the mesh the sniper shell can penetrate.  
    
killRadius = 1.0f  
Radius of which it has to hit the Eyepoint dot to snipe.

 SprayBombClass 

 Classlabel: "spraybomb"  
  
**Class Tree: Entity->Ordnance->Bullet->Grenade->SprayBomb**  
  
**Description:**  
Spray Bomb is a Grenade that turns into a GameObject when it lands and comes to a stop.  
  
**ODF Properties:**  
* **\[SprayBombClass\]**  
    
payloadName = ""  
ODF name of the GameObject Class this object turns into when it stops moving.  
    
bounceRatio = 0.1f  
Percent of Velocity retained after it bounces off the ground.  
    
soundBounce = "bounce.wav"  
Sound file played when it bounces off the Ground / Buildings.  
    
HitExplodeTypes = 0  
If this is > 0, it is a Bit Mask for which types of objects it Detonates on. Valid values are:  
   * 1 = Building  
   * 2 = Craft  
   * 4 = Person  
   * 8 = Other  
   * 16 = Terrain  
    
BuildSprayOnHit = true  
If this is false, it won't build payloadName when it hits a valid HitType.  
_Note:_ Only applies if HitExplodeTypes is not 0.  
    
ExplodeOnHit = false  
If true, will generate an Explosion Class when it hits a valid HitType.  
_Note:_ Only applies if HitExplodeTypes is not 0.

 ThermalMissileClass 

 Classlabel: "thermalmissile"  
  
**Class Tree: Entity->Ordnance->Bullet->Missile->ThermalMissile**  
  
**Description:**  
Thermal Missile is a Missile that homes in on the Heat Signature of an object.  
  
**Default ODF Properties:**  

\[OrdnanceClass\] ammoCost = 10 \[MissileClass\] omegaTurn = 1.0f

  
**ODF Properties:**  
* **\[ThermalMissileClass\]**  
    
coneAngle = 0.314159  
The cone angle which it can lock onto Targets. This is in radians.  
    
lockRange = lfieSpan \* shotSpeed \* 1.25f  
Range which it can seek a target on it's own.  
    
    
ActLikeBZ2 = true  
If true, can be distracted by any passing units, and loses it's target if it goes outside coneAngle. If false, prioritizes it's locked on Target (if any), and continues to track it even if it's outside the missile's coneAngle.

 ExplosionClass 

 Classlabel: "explosion"  
  
**Class Tree: Entity->Explosion**  
  
**Description:**  
Explosion Class is an instant Damage and Kick effect, with distance falloff.  
  
**ODF Properties:**  
* **\[ExplosionClass\]**  
    
particleCount = 0  
Number of Particle Fx. Max is 16.  
    
For each Particle Count:  
particleClass1 ... particleClass16 = ""  
The Render Name for this Particle emitter.  
    
particlePosVar1 ... particlePosVar16 = "0.0 0.0 0.0"  
Particle starting Position variance.  
    
particleBias1 ... particleBias16 = "0.0 0.0 0.0"  
Particle base Velocity.  
    
particleVeloc1 ... particleVeloc16 = "0.0 0.0 0.0"  
Particle Velocity variance applied in addition to particleBias.  
    
particleInherit1 ... particleInherit16 = "0.0 0.0 0.0"  
Percent of Inherited velocity applied. 0.0 - 1.0 for each Axis.  
    
explSound = ""  
Sound file played with this Explosion.  
    
damageRadius = 0.0f  
Radius that Damage is applied near this object.  
    
damageValue(N) = 0  
Damage value done to objects with no Shield and Armor class N.  
    
damageValue(L) = 0  
Damage value done to objects with no Shield and Armor class L.  
    
damageValue(H) = 0  
Damage value done to objects with no Shield and Armor class H.  
    
damageValue(S) = 0  
Damage value done to objects with Shield class S.  
    
damageValue(D) = 0  
Damage value done to objects with Shield class D.  
    
damageValue(A) = 0  
Damage value done to objects with Shield class A.  
    
kickRadius = 0.0f  
Radius that Kick effect is applied.  
    
kickVeloc = 0.0f  
Kick Velocity applied to objects nearby.  
    
kickOmega = 0.0f  
Kick Omega applied to objects nearby.  
    
StartUpright = false  
If this is true, creates the Explosion oriented up. If false it generates it perpendicular to Terrain normal.  
    
FriendlyFireDamage = false  
If true, Friendly units can receive Damage from this Explosion.  
    
ChunkExplodeHeight = 0.0f  
Height above the ground the Chunks must get before they Explode.  
_Note_: Only used by Chunk Explosions.  
    
ChunkScrapValue = 0  
The amount of Scrap dropped by ChunkScrapClass1...3.  
_Note_: Only used by Chunk Explosions.  
    
ChunkScrapClass1 ... ChunkScrapClass3 = ""  
If ChunkScrapValue is > 0, it chooses between these 3 classes of Scrap to drop.  
_Note_: Only used by Chunk Explosions.

 QuakeBlastClass 

 Classlabel: "quakeblast"  
  
Class Tree: Entity->Explosion->QuakeBlast  
  
**Description:**  
An Explosion Class that also launches Ordnance in a circle around it, and generates a Quake event.  
  
**ODF Properties:**  
* **\[QuakeBlastClass\]**  
    
quakeCount = 0  
How many Ordnance to generate.  
    
quakeClass = ""  
ODF name of the Ordnance Class to emit.  
    
pitchVariance = 0.0f  
Variance in the vertical trajectory of the Ordnance.  
    
yawVariance = 0.0f  
Variance in the horizontal trajectory of the Ordnance.  
    
initialPitch = 0.0f  
Initial Pitch of the Ordnance trajectory.  
    
initialYaw = 0.0f  
Initial Yaw of the Ordnance trajectory.  
    
quakeMagnitude = 5.0f  
Magnitude of the Quake event.  
    
quakeTime = 3.0f  
Time in seconds the Quake lasts.  
_Note:_ in BZCC version 2.0.185 (current version), do not put a value of 0 in this field.
