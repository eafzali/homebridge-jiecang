/* eslint-disable no-console */
import {PlatformAccessory, Service} from 'homebridge';
import {JiecangDeskController} from './platform';
import {createBluetooth} from 'node-ble';
import struct from '@aksel/structjs';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */

const CmdStop = Buffer.from('f1f12b002b7e', 'hex');
const CmdRaise = Buffer.from('f1f10100017e', 'hex');
const CmdLower = Buffer.from('f1f10200027e', 'hex');
const CmdQuery = Buffer.from('f1f10700077e', 'hex');

export class DeskAccessory {
  private service: Service;

  private currentPos = 0;
  private targetPos = 0;

  private cycle = 0;

  private state;

  private commander;

  private problem: any = new Error('No Connection');
  private cleanup: any = null;

  constructor(
    private readonly platform: JiecangDeskController,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Jiecang')
      .setCharacteristic(this.platform.Characteristic.Model, 'Bluetooth Desk Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'JCP35N-BLT');

    this.accessory.category = this.platform.api.hap.Categories.OTHER;

    // get the WindowCovering service if it exists, otherwise create a new WindowCovering service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.WindowCovering)
      || this.accessory.addService(this.platform.Service.WindowCovering);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // Initialize our state as stopped.
    this.state = this.platform.Characteristic.PositionState.STOPPED;
    this.service.setCharacteristic(this.platform.Characteristic.PositionState, this.state);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/WindowCovering
    // create handlers for required characteristics

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .updateValue(this.problem);

    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handlePositionStateGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.handleTargetPositionGet.bind(this))
      .onSet(this.handleTargetPositionSet.bind(this));


    this.platform.log.debug('configuring desk: ', this.accessory.context.device);

    this.apply().catch(e => {
      this.platform.log.error('apply faield', e);
    });

    /**
     * Creating multiple services of the same type.
     *
     * To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
     * when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
     * this.accessory.getService('NAME') || this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE_ID');
     *
     * The USER_DEFINED_SUBTYPE must be unique to the platform accessory (if you platform exposes multiple accessories, each accessory
     * can use the same sub type id.)
     */
  }

  async init() {
    this.platform.log.info('init desk');
    if (this.cleanup) {
      await this.cleanup();
      this.cleanup = null;
    }
    const {bluetooth, destroy} = createBluetooth();
    const adapter = await bluetooth.defaultAdapter();

    const device = await adapter.waitDevice(this.accessory.context.device.macAddress);
    await device.connect();
    const gattServer = await device.gatt();

    const deskService = await gattServer.getPrimaryService('0000ff12-0000-1000-8000-00805f9b34fb');

    const status = await deskService.getCharacteristic('0000ff02-0000-1000-8000-00805f9b34fb');
    await status.startNotifications();
    status.on('valuechanged', buffer => {
      const [ h1, b1, b2, height ] = struct('hbbh').unpack(Uint8Array.from(buffer).buffer);
      this.currentPos = this.HeightToPercentage(height/10);
      this.platform.log.debug('update cur height', height, this.currentPos, h1, b1, b2);
      this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition).updateValue(this.currentPos);
      if (this.state === this.platform.Characteristic.PositionState.STOPPED) {
        this.targetPos = this.currentPos;
        this.platform.log.debug('update target height', height, this.targetPos);
        this.service.getCharacteristic(this.platform.Characteristic.TargetPosition).updateValue(this.targetPos);
      } else if (this.state === this.platform.Characteristic.PositionState.INCREASING && this.currentPos >= this.targetPos) {
        this.state = this.platform.Characteristic.PositionState.STOPPED;
        this.commander.writeValue(CmdStop);
        this.platform.log.debug('run stop');
      } else if (this.state === this.platform.Characteristic.PositionState.DECREASING && this.currentPos <= this.targetPos) {
        this.state = this.platform.Characteristic.PositionState.STOPPED;
        this.commander.writeValue(CmdStop);
        this.platform.log.debug('run stop');
      }
    });

    this.commander = await deskService.getCharacteristic('0000ff01-0000-1000-8000-00805f9b34fb');
    await this.commander.writeValue(CmdQuery);
    await this.commander.writeValue(CmdQuery);
    this.problem = null;
    this.platform.log.info('init desk done');
    this.cleanup = async () => {
      await device.disconnect();
      destroy();
    };
  }

  async apply() {
    // eslint-disable-next-line no-constant-condition
    while (true){

      if(this.problem){
        try {
          this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition).updateValue(this.problem);
          await this.init();
        } catch (e: any) {
          this.platform.log.error('init failed', e);
          continue;
        }
      }

      while (!this.commander) {
        await delay(1000);
      }

      if(this.state === this.platform.Characteristic.PositionState.STOPPED) {
        await delay(500);
        continue;
      }

      let cmd;
      if (this.state === this.platform.Characteristic.PositionState.INCREASING) {
        cmd = CmdRaise;
        if (this.currentPos >= this.targetPos-2) {
          this.state = this.platform.Characteristic.PositionState.STOPPED;
          cmd = CmdStop;
        }
      } else if (this.state === this.platform.Characteristic.PositionState.DECREASING) {
        cmd = CmdLower;
        if (this.currentPos <= this.targetPos+2) {
          this.state = this.platform.Characteristic.PositionState.STOPPED;
          cmd = CmdStop;
        }
      } else if (this.cycle++ % 100 === 0){
        cmd = CmdQuery;
        this.cycle = 0;
      }

      if (!cmd){
        continue;
      }

      try {
        this.platform.log.debug('run cmd', cmd);
        await this.commander.writeValue(cmd);
        await delay(500);
      } catch (e: any) {
        this.platform.log.error('cannot run command', e);
        this.problem = e;
      }
    }
  }



  // Percentage to height (easy!)
  // Height = "min" + ("percentage" / 100) * ("max" - "min")
  // height to percentage (a bit more tricky, but solvable)
  // Percentage = (100 * "height") / ("max" - "min") - (100 * "min") / ("max" - "min")

  PercentageToHeight(percentage: number) {
    const range = this.accessory.context.device.maxHeight - this.accessory.context.device.baseHeight;
    return Math.round(this.accessory.context.device.baseHeight + (percentage / 100) * range);
  }

  HeightToPercentage(height: number) {
    const range = this.accessory.context.device.maxHeight - this.accessory.context.device.baseHeight;
    const r = Math.round( (100 * height) / range
        - (100 * this.accessory.context.device.baseHeight) / range);

    if (r < 0) {
      return 0;
    } else if (r > 100) {
      return 100;
    }

    return r;
  }

  // HomeKit setter & getters
  // TargetPosition get & set
  // CurrentPosition get
  // PositionState get

  /**
   * Handle requests to set the "Target Position" characteristic
   */
  handleTargetPositionSet(value) {
    this.platform.log.debug('Triggered SET TargetPosition:', value);

    this.targetPos = value;
    if (this.targetPos > this.currentPos) {
      this.state = this.platform.Characteristic.PositionState.INCREASING;
    } else if (this.targetPos < this.currentPos) {
      this.state = this.platform.Characteristic.PositionState.DECREASING;
    }
  }

  /**
   * Handle requests to get the current value of the "Target Position" characteristic
   */
  handleTargetPositionGet() {
    this.platform.log.debug('Triggered GET TargetPosition');

    return this.targetPos;
  }

  /**
   * Handle requests to get the current value of the "Position State" characteristic
   */
  handlePositionStateGet() {
    this.platform.log.debug('Triggered GET PositionState');

    if (this.targetPos > this.currentPos) {
      return this.platform.Characteristic.PositionState.INCREASING;
    } else if (this.targetPos < this.currentPos) {
      return this.platform.Characteristic.PositionState.DECREASING;
    }

    return this.platform.Characteristic.PositionState.STOPPED;
  }

}

function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}
