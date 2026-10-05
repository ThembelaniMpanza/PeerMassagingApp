import 'package:flutter_test/flutter_test.dart';
import 'package:peer_messaging_app/messaging/message_model.dart';

void main() {
  test('message model serializes to JSON and round-trips', () {
    const message = MessageModel(
      id: 'msg_1',
      senderId: 'device_a',
      senderName: 'Alpha',
      text: 'hello from test',
      timestamp: '2026-09-17T12:00:00Z',
      type: MessageType.text,
    );

    final json = message.toJson();
    final roundTrip = MessageModel.fromJson(json);

    expect(json['type'], equals('text'));
    expect(roundTrip.id, equals('msg_1'));
    expect(roundTrip.text, equals('hello from test'));
  });
}
