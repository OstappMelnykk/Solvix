import { TestBed } from '@angular/core/testing';
import { RenderSettingsSplitService } from './render-settings-split.service';

describe('RenderSettingsSplitService', () => {
  let split: RenderSettingsSplitService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    split = TestBed.inject(RenderSettingsSplitService);
  });

  it('keeps a width of its own for the Quality World: 30% to begin with, between 20% and 50%', () => {
    expect(split.qualityWidth()).toBe(30);
    expect(split.qualityMinWidth).toBe(20);
    expect(split.qualityMaxWidth).toBe(50);
  });

  it('does not let the Quality World\'s width change the other Worlds\' panel, nor the other way round', () => {
    const settings = split.settingsWidth();

    split.setQualityWidth(45);
    expect(split.qualityWidth()).toBe(45);
    expect(split.settingsWidth()).toBe(settings);

    split.setSettingsWidth(35);
    expect(split.qualityWidth()).toBe(45);
  });

  it('lets the other Worlds\' panel grow to 40% only', () => {
    expect(split.settingsMaxWidth).toBe(40);
  });
});
