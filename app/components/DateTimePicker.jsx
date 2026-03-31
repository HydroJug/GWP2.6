import { useState, useEffect, useCallback, useRef } from "react";
import {
  Popover,
  DatePicker,
  TextField,
  Icon,
  InlineStack,
  BlockStack,
  Button,
} from "@shopify/polaris";
import { CalendarIcon, ClockIcon } from "@shopify/polaris-icons";

const TIME_SLOTS = (() => {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const val = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const ampm = h >= 12 ? "PM" : "AM";
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      slots.push({ value: val, label: `${hour12}:${String(m).padStart(2, "0")} ${ampm}` });
    }
  }
  return slots;
})();

function parseTimeString(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const match12 = s.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)$/);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const m = parseInt(match12[2] || "0", 10);
    const pm = match12[3] === "pm";
    if (h < 1 || h > 12 || m > 59) return null;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h, m };
  }
  const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const h = parseInt(match24[1], 10);
    const m = parseInt(match24[2], 10);
    if (h > 23 || m > 59) return null;
    return { h, m };
  }
  return null;
}

function to24(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function to12(time24) {
  if (!time24) return "";
  const [h, m] = time24.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function parseDateTimeValue(value) {
  if (!value) return { date: null, time: "12:00" };
  const d = new Date(value);
  if (isNaN(d.getTime())) return { date: null, time: "12:00" };
  return { date: d, time: to24(d.getHours(), d.getMinutes()) };
}

function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDisplay(date, time24) {
  if (!date) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateStr = `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  return time24 ? `${dateStr} at ${to12(time24)}` : dateStr;
}

function combineDateAndTime(date, time24) {
  if (!date) return "";
  return `${formatDateISO(date)}T${time24 || "00:00"}`;
}

export default function DateTimePicker({ label, value, onChange, helpText }) {
  const { date: initialDate, time: initialTime } = parseDateTimeValue(value);

  const [visible, setVisible] = useState(false);
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [time24, setTime24] = useState(initialTime);
  const [timeInput, setTimeInput] = useState(() => to12(initialTime));
  const [showTimeSlots, setShowTimeSlots] = useState(false);
  const [{ month, year }, setMonthYear] = useState(() => {
    const d = initialDate || new Date();
    return { month: d.getMonth(), year: d.getFullYear() };
  });
  const timeSlotsRef = useRef(null);

  useEffect(() => {
    const { date, time } = parseDateTimeValue(value);
    setSelectedDate(date);
    setTime24(time);
    setTimeInput(to12(time));
    if (date) {
      setMonthYear({ month: date.getMonth(), year: date.getFullYear() });
    }
  }, [value]);

  useEffect(() => {
    if (showTimeSlots && timeSlotsRef.current) {
      const active = timeSlotsRef.current.querySelector("[data-active]");
      if (active) active.scrollIntoView({ block: "center" });
    }
  }, [showTimeSlots]);

  const handleDateSelection = useCallback(({ end: newDate }) => {
    setSelectedDate(newDate);
  }, []);

  const handleMonthChange = useCallback((m, y) => {
    setMonthYear({ month: m, year: y });
  }, []);

  const handleTimeInputChange = useCallback((val) => {
    setTimeInput(val);
    setShowTimeSlots(false);
  }, []);

  const handleTimeBlur = useCallback(() => {
    setTimeout(() => {
      const parsed = parseTimeString(timeInput);
      if (parsed) {
        const newTime = to24(parsed.h, parsed.m);
        setTime24(newTime);
        setTimeInput(to12(newTime));
      } else {
        setTimeInput(to12(time24));
      }
    }, 150);
  }, [timeInput, time24]);

  const selectTimeSlot = useCallback((val) => {
    setTime24(val);
    setTimeInput(to12(val));
    setShowTimeSlots(false);
  }, []);

  const toggleTimeSlots = useCallback(() => {
    setShowTimeSlots((prev) => !prev);
  }, []);

  const handleApply = useCallback(() => {
    const parsed = parseTimeString(timeInput);
    const finalTime = parsed ? to24(parsed.h, parsed.m) : time24;
    setTime24(finalTime);
    setTimeInput(to12(finalTime));
    setShowTimeSlots(false);
    setVisible(false);
    if (selectedDate) onChange(combineDateAndTime(selectedDate, finalTime));
  }, [selectedDate, time24, timeInput, onChange]);

  const handleClear = useCallback(() => {
    setSelectedDate(null);
    setTime24("12:00");
    setTimeInput("12:00 PM");
    setShowTimeSlots(false);
    setVisible(false);
    onChange("");
  }, [onChange]);

  return (
    <Popover
      active={visible}
      autofocusTarget="none"
      preferredAlignment="left"
      fullWidth
      preferInputActivator={false}
      preferredPosition="below"
      preventCloseOnChildOverlayClick
      onClose={handleApply}
      activator={
        <TextField
          role="combobox"
          label={label}
          prefix={<Icon source={CalendarIcon} />}
          value={formatDisplay(selectedDate, time24)}
          onFocus={() => setVisible(true)}
          onChange={() => {}}
          autoComplete="off"
          helpText={helpText}
          placeholder="Select date and time"
        />
      }
    >
      <div style={{ padding: 16, minWidth: 280 }}>
        <BlockStack gap="300">
          <DatePicker
            month={month}
            year={year}
            selected={selectedDate}
            onMonthChange={handleMonthChange}
            onChange={handleDateSelection}
          />
          <div style={{ position: "relative" }}>
            <div
              onClick={toggleTimeSlots}
              style={{ position: "absolute", left: 8, top: 28, zIndex: 2, cursor: "pointer", padding: "4px 2px" }}
            >
              <Icon source={ClockIcon} />
            </div>
            <TextField
              label="Time"
              value={timeInput}
              onChange={handleTimeInputChange}
              onBlur={handleTimeBlur}
              prefix={<span />}
              placeholder="e.g. 2:30 PM"
              autoComplete="off"
            />
            {showTimeSlots && (
              <div
                ref={timeSlotsRef}
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  zIndex: 10,
                  maxHeight: 200,
                  overflowY: "auto",
                  background: "var(--p-color-bg-surface)",
                  border: "1px solid var(--p-color-border)",
                  borderRadius: "var(--p-border-radius-200)",
                  boxShadow: "var(--p-shadow-300)",
                }}
              >
                {TIME_SLOTS.map((slot) => {
                  const isActive = slot.value === time24;
                  return (
                    <button
                      key={slot.value}
                      {...(isActive ? { "data-active": true } : {})}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectTimeSlot(slot.value)}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "8px 14px",
                        fontSize: 13,
                        fontWeight: isActive ? 600 : 400,
                        textAlign: "left",
                        border: "none",
                        cursor: "pointer",
                        background: isActive ? "var(--p-color-bg-surface-active)" : "none",
                        color: "var(--p-color-text)",
                      }}
                    >
                      {slot.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <InlineStack align="end" gap="200">
            <Button size="slim" onClick={handleClear}>Clear</Button>
            <Button size="slim" variant="primary" onClick={handleApply}>Apply</Button>
          </InlineStack>
        </BlockStack>
      </div>
    </Popover>
  );
}
