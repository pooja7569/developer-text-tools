import csv
import json
import re

import pandas as pd

MAX_LOG_BYTES = 256 * 1024
MAX_LINES = 2000
MAX_COLUMNS = 100

KEY_VALUE = re.compile(
    r"""(?P<key>[A-Za-z_][\w.-]*)=(?P<value>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"']+)"""
)
ACCESS_LOG = re.compile(
    r'^(?:(?P<remote_addr>\S+) (?P<ident>\S+) (?P<user>\S+) )?'
    r'\[(?P<timestamp>[^\]]+)\] "(?P<request>[^"]+)" '
    r'(?P<status>\d{3}) (?P<bytes>\d+|-)'
    r'(?: "(?P<referer>[^"]*)" "(?P<user_agent>[^"]*)")?$'
)


def reject_constant(value):
    raise ValueError('Non-finite JSON numbers are not supported.')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON keys are not supported.')
        result[key] = value
    return result


def parse_line(line):
    if line.startswith('{'):
        record = json.loads(
            line, parse_constant=reject_constant, object_pairs_hook=unique_object,
        )
        if not isinstance(record, dict) or not record:
            raise ValueError('Expected a nonempty JSON object.')
        return record

    access = ACCESS_LOG.fullmatch(line)
    if access:
        record = {key: value for key, value in access.groupdict().items() if value is not None}
        parts = record['request'].split(' ', 2)
        if len(parts) == 3:
            record.update(zip(('method', 'path', 'protocol'), parts))
        elif record['request'] != '-':
            raise ValueError('Invalid access-log request field.')
        return record

    record = {}
    end = 0
    for match in KEY_VALUE.finditer(line):
        gap = line[end:match.start()].strip()
        if not record and gap:
            if '=' in gap:
                raise ValueError('Malformed key-value field.')
            record['_prefix'] = gap
        elif gap:
            raise ValueError('Unexpected text between key-value fields.')
        key, value = match.group('key', 'value')
        if key in record:
            raise ValueError('Duplicate key-value fields are not supported.')
        if value.startswith('"'):
            value = json.loads(value)
        elif value.startswith("'"):
            value = re.sub(r"\\(['\\])", r'\1', value[1:-1])
        record[key] = value
        end = match.end()
    if not record or line[end:].strip():
        raise ValueError('Use key=value logs, JSON Lines, or common/combined access logs.')
    return record


def csv_cell(value):
    if value is None:
        text = ''
    elif isinstance(value, (dict, list, bool)):
        text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    else:
        text = str(value)
    # Spreadsheet software must not execute imported formulas.
    return "'" + text if text.lstrip().startswith(('=', '+', '-', '@')) else text


def logs_to_csv(log):
    if not isinstance(log, str) or not log.strip():
        raise ValueError('Provide a nonblank log string.')
    if len(log.encode('utf-8')) > MAX_LOG_BYTES:
        raise ValueError('Log input must not exceed 256 KiB.')
    lines = log.splitlines()
    if len(lines) > MAX_LINES:
        raise ValueError('Log input must not exceed 2,000 lines.')
    records = []
    columns = []
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            record = parse_line(line.strip())
        except (ValueError, RecursionError) as error:
            raise ValueError(f'Line {number}: unsupported or malformed log record.') from error
        if len(record) > MAX_COLUMNS:
            raise ValueError(f'Line {number}: too many columns (maximum 100).')
        for key in record:
            if key not in columns:
                columns.append(key)
        if len(columns) > MAX_COLUMNS:
            raise ValueError('Combined log columns must not exceed 100.')
        records.append({key: csv_cell(value) for key, value in record.items()})
    headers = [csv_cell(key) for key in columns]
    if len(set(headers)) != len(headers):
        raise ValueError('Column names conflict after spreadsheet-safety escaping.')
    frame = pd.DataFrame.from_records(records, columns=columns).fillna('')
    return frame.to_csv(
        index=False, header=headers, lineterminator='\r\n', quoting=csv.QUOTE_MINIMAL,
    )
