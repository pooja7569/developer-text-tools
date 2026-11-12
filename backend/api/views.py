from django.db import transaction
from django.http import HttpResponse

from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    parser_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateDestroyAPIView
from rest_framework.parsers import JSONParser
from rest_framework.views import APIView
from rest_framework.throttling import AnonRateThrottle

from .models import Note
from .permissions import ExtensionToolsRequest, LocalNotesRequest
from .log_parser import logs_to_csv
from .serializers import NoteSerializer, NotesBackupSerializer


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
def greet(request):
    return Response({'message': 'Hello from your Django backend!'})


@api_view(['POST'])
@authentication_classes([])
@permission_classes([ExtensionToolsRequest])
@parser_classes([JSONParser])
@throttle_classes([AnonRateThrottle])
def log_to_csv_view(request):
    if not isinstance(request.data, dict):
        return Response({'detail': 'Send a JSON object with a log string.'}, status=400)
    try:
        output = logs_to_csv(request.data.get('log'))
    except ValueError as error:
        return Response({'detail': str(error)}, status=400)
    response = HttpResponse(output, content_type='text/csv; charset=utf-8')
    response['Content-Disposition'] = 'attachment; filename="logs.csv"'
    response['Cache-Control'] = 'no-store'
    return response


class NotesView(ListCreateAPIView):
    queryset = Note.objects.all()
    serializer_class = NoteSerializer
    authentication_classes = []
    permission_classes = [LocalNotesRequest]
    parser_classes = [JSONParser]
    http_method_names = ['get', 'post', 'head', 'options']


class NoteDetailView(RetrieveUpdateDestroyAPIView):
    queryset = Note.objects.all()
    serializer_class = NoteSerializer
    authentication_classes = []
    permission_classes = [LocalNotesRequest]
    parser_classes = [JSONParser]
    http_method_names = ['patch', 'delete', 'options']


class NotesImportView(APIView):
    authentication_classes = []
    permission_classes = [LocalNotesRequest]
    parser_classes = [JSONParser]
    http_method_names = ['post', 'options']

    @transaction.atomic
    def post(self, request):
        if len(request.body) > 1024 * 1024:
            return Response(
                {'detail': 'Backup must be at most 1 MB (1,048,576 bytes).'},
                status=413,
            )
        serializer = NotesBackupSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        entries = serializer.validated_data['notes']
        seen = {text.strip() for text in Note.objects.values_list('text', flat=True)}
        new_notes = []
        for entry in entries:
            text = entry['text']
            if text not in seen:
                new_notes.append(Note(text=text))
                seen.add(text)
        Note.objects.bulk_create(new_notes)
        return Response({
            'imported': len(new_notes),
            'skipped': len(entries) - len(new_notes),
            'notes': NoteSerializer(Note.objects.all(), many=True).data,
        })
