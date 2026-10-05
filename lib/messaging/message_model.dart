enum MessageType {
  text,
  fileOffer,
  typing,
  readReceipt,
}

extension MessageTypeValue on MessageType {
  String get value => switch (this) {
        MessageType.text => 'text',
        MessageType.fileOffer => 'file_offer',
        MessageType.typing => 'typing',
        MessageType.readReceipt => 'read_receipt',
      };

  static MessageType fromValue(String value) {
    switch (value) {
      case 'text':
        return MessageType.text;
      case 'file_offer':
        return MessageType.fileOffer;
      case 'typing':
        return MessageType.typing;
      case 'read_receipt':
        return MessageType.readReceipt;
      default:
        return MessageType.text;
    }
  }
}

class MessageModel {
  const MessageModel({
    required this.id,
    required this.senderId,
    required this.senderName,
    required this.text,
    required this.timestamp,
    required this.type,
  });

  final String id;
  final String senderId;
  final String senderName;
  final String text;
  final String timestamp;
  final MessageType type;

  factory MessageModel.fromJson(Map<String, dynamic> json) {
    return MessageModel(
      id: json['id']?.toString() ?? '',
      senderId: json['senderId']?.toString() ?? '',
      senderName: json['senderName']?.toString() ?? '',
      text: json['text']?.toString() ?? '',
      timestamp: json['timestamp']?.toString() ?? DateTime.now().toUtc().toIso8601String(),
      type: MessageTypeValue.fromValue(json['type']?.toString() ?? 'text'),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'senderId': senderId,
      'senderName': senderName,
      'text': text,
      'timestamp': timestamp,
      'type': type.value,
    };
  }
}
