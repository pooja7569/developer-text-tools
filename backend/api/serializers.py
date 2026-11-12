from rest_framework import serializers

from .models import Note


class NoteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Note
        fields = ['id', 'text', 'created_at']
        read_only_fields = ['id', 'created_at']


class BackupNoteSerializer(serializers.Serializer):
    id = serializers.IntegerField(min_value=1, max_value=9007199254740991)
    text = serializers.CharField(max_length=2000)
    created_at = serializers.DateTimeField()

    def to_internal_value(self, data):
        if isinstance(data, dict) and type(data.get('id')) is not int:
            raise serializers.ValidationError({'id': 'Note id must be a positive integer.'})
        if isinstance(data, dict) and not isinstance(data.get('text'), str):
            raise serializers.ValidationError({'text': 'Note text must be a string.'})
        return super().to_internal_value(data)


class NotesBackupSerializer(serializers.Serializer):
    version = serializers.JSONField()
    exported_at = serializers.DateTimeField()
    notes = BackupNoteSerializer(many=True, max_length=500)

    def validate_version(self, value):
        if type(value) is not int or value != 1:
            raise serializers.ValidationError('Only backup version 1 is supported.')
        return value
